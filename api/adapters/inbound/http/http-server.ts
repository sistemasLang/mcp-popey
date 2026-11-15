import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { InternalErrorLogger } from '../../../application/ports/outbound/internal-error-log.port.js';
import { AuthenticationError } from '../../../domain/errors.js';
import type { UserContext } from '../../../domain/user-context.js';
import { createMcpServer, type McpUseCases } from '../mcp/mcp-server.js';
import type { BearerAuth } from './bearer-auth.js';

export const MCP_PATH = '/mcp';

export interface HttpServerDependencies {
  auth: BearerAuth;
  mcp: McpUseCases;
  logInternalError: InternalErrorLogger;
}

/**
 * Stateless Streamable HTTP: one McpServer + transport per request, created
 * only after the bearer token has been turned into a UserContext.
 * Meant to listen on 127.0.0.1 behind a TLS reverse proxy (nginx).
 */
export function createHttpServer(deps: HttpServerDependencies): Server {
  return createServer((request, response) => {
    handle(request, response, deps).catch((error: unknown) => {
      deps.logInternalError(error);
      if (!response.headersSent) writeJsonRpcError(response, 500, -32603, 'Internal error');
    });
  });
}

async function handle(request: IncomingMessage, response: ServerResponse, deps: HttpServerDependencies): Promise<void> {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (path !== MCP_PATH) {
    response.writeHead(404).end();
    return;
  }

  let user: UserContext;
  try {
    user = await deps.auth.authenticate(request);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      response.setHeader('WWW-Authenticate', 'Bearer realm="mcp-popey"');
      writeJsonRpcError(response, 401, -32001, 'Unauthorized');
      return;
    }
    throw error;
  }

  const server = createMcpServer(user, deps.mcp);
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on('close', () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(request, response);
}

function writeJsonRpcError(response: ServerResponse, status: number, code: number, message: string): void {
  response
    .writeHead(status, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}
