/**
 * mcp-popey: MCP server to query the Popey ERP read-only, isolated per tenant,
 * plus the API of its admin panel.
 *
 *   The AI writes the SQL. Node authenticates the caller and picks the database.
 *   PostgreSQL guarantees it is read-only and what can be read (role mcp_popey_ro).
 *
 * Request flow:
 *   http.ts     /mcp: JWT (auth.ts) → user from users.yaml (users.ts) → tools/*
 *               /admin/api: JWT with the admin audience → admin.ts → Auth0 (auth0.ts) + users.yaml
 *   tools/*     list_circuits, describe_circuit (circuits.ts), query_sql (db.ts)
 *   audit.ts    one JSON line per tool call and per admin write
 */
import { bootstrapAdmins } from './admin.js';
import { createAudit } from './audit.js';
import { createTokenVerifier } from './auth.js';
import { createAuth0 } from './auth0.js';
import { loadCatalog } from './circuits.js';
import { loadConfig, loadDotEnv } from './config.js';
import { createDatabase } from './db.js';
import { createHttpServer, type App } from './http.js';
import { createRateLimiter } from './tools/query-sql.js';
import { createUserStore } from './users.js';

/** Upper bound for a graceful stop: open SSE streams must not block a pm2 restart. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const catalog = loadCatalog(config.circuitsFile, config.circuitAccessFile);
  const database = createDatabase(config);

  const app: App = {
    issuer: config.issuer,
    resourceUrl: config.resourceUrl,
    verifyToken: createTokenVerifier({ issuer: config.issuer, audiences: { mcp: config.resourceUrl, admin: config.adminAudience } }),
    users: createUserStore(config.usersFile),
    auth0: createAuth0({ ...config.auth0, mcpAudience: config.resourceUrl }),
    databaseKeys: [...config.databases.keys()],
    catalog,
    runSql: database.runSql,
    maxRows: config.maxRows,
    rateLimit: createRateLimiter(config.rateLimit),
    audit: createAudit(config.auditLogFile),
  };

  // Validates users.yaml now (a broken file stops the start) and links the first admins.
  const bootstrapped = await bootstrapAdmins(app, config.bootstrapAdminEmails);
  const userCount = app.users.list().length;

  const httpServer = createHttpServer(app);
  httpServer.on('error', (error: NodeJS.ErrnoException) => {
    const reason = error.code === 'EADDRINUSE' ? `port ${config.port} on ${config.host} is already in use` : error.message;
    console.error(`mcp-popey cannot listen: ${reason}`);
    process.exit(1);
  });
  httpServer.listen(config.port, config.host, () => {
    console.error(
      `mcp-popey listening on http://${config.host}:${config.port}/mcp (${catalog.circuits.size} circuits, ` +
        `${catalog.roles.size} roles, ${userCount} users${bootstrapped ? ` (${bootstrapped} bootstrapped admins)` : ''}, ` +
        `issuer: ${config.issuer}, databases: ${app.databaseKeys.join(', ') || 'none'})`,
    );
  });

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    console.error(`mcp-popey received ${signal}, shutting down`);
    setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS).unref();
    httpServer.close(() => void database.close().finally(() => process.exit(0)));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
