import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import { ADMIN_PREFIX, handleAdminApi } from './admin.js';
import type { Audit } from './audit.js';
import { bearerToken, mcpUser, type Surface } from './auth.js';
import type { Auth0 } from './auth0.js';
import type { Catalog } from './circuits.js';
import type { RunSql } from './db.js';
import { logInternalError } from './errors.js';
import { registerDescribeCircuit } from './tools/describe-circuit.js';
import { registerListCircuits } from './tools/list-circuits.js';
import { registerQuerySql } from './tools/query-sql.js';
import type { UserStore } from './users.js';

/** Everything a request needs. Built once in index.ts; tests build it with fakes. */
export interface App {
  issuer: string;
  /** Public URL of /mcp (MCP_RESOURCE_URL). */
  resourceUrl: string;
  /** Verified token for that surface → subject, or null. */
  verifyToken: (token: string, surface: Surface) => Promise<string | null>;
  users: UserStore;
  /** Auth0 Management API, used only by the admin panel. */
  auth0: Auth0;
  /** DATABASE_KEYS: the tenants an admin can assign. */
  databaseKeys: string[];
  catalog: Catalog;
  runSql: RunSql;
  maxRows: number;
  rateLimit: (userId: string) => void;
  audit: Audit;
}

const MCP_PATH = '/mcp';
const METADATA_PATH = '/.well-known/oauth-protected-resource';

/**
 * Routes:
 *   GET  /.well-known/oauth-protected-resource[/mcp]  public metadata (RFC 9728): where to log in.
 *   *    /mcp                                         MCP over Streamable HTTP, OAuth required.
 *   *    /admin/api/*                                 admin panel API (admin.ts), its own token audience.
 *   anything else                                     404.
 * Listens on 127.0.0.1 behind nginx, which terminates TLS.
 */
export function createHttpServer(app: App): Server {
  return createServer((request, response) => {
    handle(app, request, response).catch((error: unknown) => {
      logInternalError(error);
      if (!response.headersSent) jsonRpcError(response, 500, -32603, 'Internal error');
    });
  });
}

async function handle(app: App, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;

  if (path === METADATA_PATH || path === METADATA_PATH + MCP_PATH) {
    if (request.method !== 'GET') return void response.writeHead(405, { Allow: 'GET' }).end();
    const metadata = { resource: app.resourceUrl, authorization_servers: [app.issuer], bearer_methods_supported: ['header'] };
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
    return void response.end(JSON.stringify(metadata));
  }
  if (path.startsWith(ADMIN_PREFIX)) return handleAdminApi(app, request, response, path);
  if (path !== MCP_PATH) return void response.writeHead(404).end();

  // 1. Identity: no token or an invalid one → 401, telling the client where to log in.
  const token = bearerToken(request);
  const subject = token ? await app.verifyToken(token, 'mcp') : null;
  if (!subject) {
    const metadataUrl = `${new URL(app.resourceUrl).origin}${METADATA_PATH}${MCP_PATH}`;
    response.setHeader('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl}"`);
    return jsonRpcError(response, 401, -32001, 'Unauthorized');
  }

  // 2. Authorization: unknown, disabled, without role + tenant, or a role not in circuit-access.yaml.
  // Same 403 for every reason (a 401 here would send MCP clients into a login loop).
  const user = mcpUser(app.users, app.issuer, subject);
  if (!user || !app.catalog.roles.has(user.role)) return jsonRpcError(response, 403, -32003, 'Forbidden');

  // One MCP server per request, bound to this user: no tool can take the user or database from its input.
  const server = new McpServer({ name: 'mcp-popey', version: '1.0.0' });
  const ctx = { user, app };
  registerListCircuits(server, ctx);
  registerDescribeCircuit(server, ctx);
  registerQuerySql(server, ctx);

  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(request, response);
}

function jsonRpcError(response: ServerResponse, status: number, code: number, message: string): void {
  response
    .writeHead(status, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}
