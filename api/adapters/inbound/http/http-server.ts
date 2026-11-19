import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { AccessTokenVerifier } from '../../../application/ports/inbound/access-token-verifier.port.js';
import type { InternalErrorLogger } from '../../../application/ports/outbound/internal-error-log.port.js';
import type { AdminUsersUseCase } from '../../../application/use-cases/admin-users.use-case.js';
import type { AuthenticateUserUseCase } from '../../../application/use-cases/authenticate-user.use-case.js';
import { AuthenticationError, ForbiddenError } from '../../../domain/errors.js';
import type { Principal } from '../../../domain/user-context.js';
import { createMcpServer, type McpUseCases } from '../mcp/mcp-server.js';
import { ADMIN_API_PREFIX, handleAdminApi } from './admin-api.js';
import { bearerToken } from './bearer-token.js';

export const MCP_PATH = '/mcp';
export const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';
const METADATA_PATHS = new Set([PROTECTED_RESOURCE_METADATA_PATH, `${PROTECTED_RESOURCE_METADATA_PATH}${MCP_PATH}`]);

export interface HttpServerDependencies {
  tokens: AccessTokenVerifier;
  authenticateUser: AuthenticateUserUseCase;
  adminUsers: AdminUsersUseCase;
  /** MCP_RESOURCE_URL and the issuer that clients must get tokens from. */
  resource: { url: string; authorizationServer: string };
  mcp: McpUseCases;
  logInternalError: InternalErrorLogger;
}

/**
 * Routes: /mcp (OAuth resource server, stateless Streamable HTTP), the
 * protected resource metadata (RFC 9728, public) and /admin/api. Everything
 * else is 404. Meant to listen on 127.0.0.1 behind a TLS reverse proxy (nginx).
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
  if (METADATA_PATHS.has(path)) return writeMetadata(request, response, deps);
  if (path.startsWith(ADMIN_API_PREFIX)) return handleAdminApi(request, response, path, deps);
  if (path !== MCP_PATH) {
    response.writeHead(404).end();
    return;
  }

  let principal: Principal;
  try {
    const identity = await deps.tokens.verify(bearerToken(request), 'mcp');
    principal = await deps.authenticateUser.execute(identity);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      // Tells MCP clients where to discover the authorization server (RFC 9728).
      const metadataUrl = `${new URL(deps.resource.url).origin}${PROTECTED_RESOURCE_METADATA_PATH}${MCP_PATH}`;
      response.setHeader('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl}"`);
      writeJsonRpcError(response, 401, -32001, 'Unauthorized');
      return;
    }
    if (error instanceof ForbiddenError) {
      // Valid token, no access: 403 (a 401 would make MCP clients loop through login).
      writeJsonRpcError(response, 403, -32003, 'Forbidden');
      return;
    }
    throw error;
  }

  const server = createMcpServer(principal, deps.mcp);
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on('close', () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(request, response);
}

function writeMetadata(request: IncomingMessage, response: ServerResponse, deps: HttpServerDependencies): void {
  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' }).end();
    return;
  }
  response
    .writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' })
    .end(
      JSON.stringify({
        resource: deps.resource.url,
        authorization_servers: [deps.resource.authorizationServer],
        bearer_methods_supported: ['header'],
      }),
    );
}

function writeJsonRpcError(response: ServerResponse, status: number, code: number, message: string): void {
  response
    .writeHead(status, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}
