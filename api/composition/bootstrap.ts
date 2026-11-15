import { randomUUID } from 'node:crypto';
import { JsonLinesAuditLogger } from '../adapters/outbound/audit/json-lines-audit.logger.js';
import { DatabaseRegistry } from '../adapters/outbound/postgres/database.registry.js';
import { CircuitLoader } from '../adapters/outbound/yaml/circuit.loader.js';
import { RolePolicyLoader } from '../adapters/outbound/yaml/role-policy.loader.js';
import { YamlUserRepository } from '../adapters/outbound/yaml/yaml-user.repository.js';
import { ManageUsersUseCase } from '../application/use-cases/manage-users.use-case.js';
import { type AppConfig, buildConfig } from '../config/config.js';
import { loadDotEnv, readEnv } from '../config/env.js';
import { CircuitRegistry } from '../domain/circuits/circuit.registry.js';
import { type Application, createApplication } from './container.js';

/** `.env` (if present) + process env → validated AppConfig. */
export function loadRuntimeConfig(): AppConfig {
  loadDotEnv();
  return buildConfig(readEnv());
}

/** Reads circuits.yaml + circuit-access.yaml. Any structural problem aborts startup. */
function loadCatalog(config: AppConfig) {
  const circuitRegistry = CircuitRegistry.fromDefinitions(CircuitLoader.loadFile(config.circuitsFile));
  const rolePolicy = RolePolicyLoader.loadFile(config.circuitAccessFile, circuitRegistry);
  return { circuitRegistry, rolePolicy };
}

export interface StartedServer {
  app: Application;
  summary: string;
}

/** Builds the MCP HTTP application from files + env (not listening yet). */
export function buildServer(config: AppConfig): StartedServer {
  const { circuitRegistry, rolePolicy } = loadCatalog(config);
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

  const summary =
    `${circuitRegistry.ids().length} circuits, ${rolePolicy.roles.size} roles, ` +
    `query_sql roles: ${[...rolePolicy.sqlRoles].join(', ') || 'none'}, ` +
    `databases: ${databases.keys().join(', ') || 'none'}`;
  return { app, summary };
}

/** User administration for the CLI. Catalog and databases load only when needed. */
export function buildManageUsers(config: AppConfig): ManageUsersUseCase {
  return new ManageUsersUseCase({
    users: new YamlUserRepository(config.usersFile),
    rolePolicy: () => loadCatalog(config).rolePolicy,
    databaseKeys: () => DatabaseRegistry.fromEnv().keys(),
    newId: randomUUID,
  });
}
