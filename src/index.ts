import { createApplication } from './app.js';
import { JsonLinesAuditLogger } from './audit/audit.logger.js';
import { CircuitLoader } from './circuits/circuit.loader.js';
import { CircuitRegistry } from './circuits/circuit.registry.js';
import { buildConfig } from './config/config.js';
import { loadDotEnv, readEnv } from './config/env.js';
import { DatabaseRegistry } from './database/database.registry.js';
import { RolePolicyLoader } from './permissions/role-policy.loader.js';
import { YamlUserRepository } from './users/user.repository.js';

function main(): void {
  loadDotEnv();
  const config = buildConfig(readEnv());

  // Any structural problem in these files aborts startup.
  const circuitRegistry = CircuitRegistry.fromDefinitions(CircuitLoader.loadFile(config.circuitsFile));
  const rolePolicy = RolePolicyLoader.loadFile(config.circuitAccessFile, circuitRegistry);
  const databases = DatabaseRegistry.fromEnv();

  const app = createApplication({
    circuitRegistry,
    rolePolicy,
    users: new YamlUserRepository(config.usersFile),
    databases,
    queryLimits: config.queryLimits,
    sqlQueryLimits: config.sqlQueryLimits,
    rateLimit: config.rateLimit,
    dbPoolMax: config.dbPoolMax,
    audit: new JsonLinesAuditLogger(config.auditLogFile),
  });

  app.httpServer.listen(config.port, config.host, () => {
    console.error(
      `mcp-popey listening on http://${config.host}:${config.port}/mcp ` +
        `(${circuitRegistry.ids().length} circuits, ${rolePolicy.roles.size} roles, ` +
        `query_sql roles: ${[...rolePolicy.sqlRoles].join(', ') || 'none'}, ` +
        `databases: ${databases.keys().join(', ') || 'none'})`,
    );
  });

  const shutdown = () => {
    app.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
