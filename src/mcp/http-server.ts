import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { AuthMiddleware } from '../auth/auth.middleware.js';
import type { UserContext } from '../auth/user-context.js';
import { AuthenticationError } from '../errors/app-errors.js';
import { logInternalError } from '../errors/error-mapper.js';
import { createMcpServer, type ToolDependencies } from './server.js';

export const MCP_PATH = '/mcp';

/**
 * Stateless Streamable HTTP: one McpServer + transport per request, created
 * only after the bearer token has been turned into a UserContext.
 */
export function createHttpServer(auth: AuthMiddleware, deps: ToolDependencies): Server {
  return createServer((request, response) => {
    handle(request, response, auth, deps).catch((error: unknown) => {
      logInternalError(error);
      if (!response.headersSent) writeJsonRpcError(response, 500, -32603, 'Internal error');
    });
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  auth: AuthMiddleware,
  deps: ToolDependencies,
): Promise<void> {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (path !== MCP_PATH) {
    response.writeHead(404).end();
    return;
  }

  let user: UserContext;
  try {
    user = await auth.authenticate(request);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      response.setHeader('WWW-Authenticate', 'Bearer realm="mcp-popey"');
      writeJsonRpcError(response, 401, -32001, 'Unauthorized');
      return;
    }
    throw error;
  }

  const server = createMcpServer(user, deps);
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
