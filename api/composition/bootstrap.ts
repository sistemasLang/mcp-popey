import { randomUUID } from 'node:crypto';
import { JwtAccessTokenVerifier } from '../adapters/inbound/http/jwt-access-token.verifier.js';
import { JsonLinesAuditLogger } from '../adapters/outbound/audit/json-lines-audit.logger.js';
import { Auth0IdentityProvider } from '../adapters/outbound/auth0/auth0-identity-provider.adapter.js';
import { DatabaseRegistry } from '../adapters/outbound/postgres/database.registry.js';
import { CircuitLoader } from '../adapters/outbound/yaml/circuit.loader.js';
import { RolePolicyLoader } from '../adapters/outbound/yaml/role-policy.loader.js';
import { YamlUserRepository } from '../adapters/outbound/yaml/yaml-user.repository.js';
import { BootstrapAdminsUseCase } from '../application/use-cases/bootstrap-admins.use-case.js';
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

/**
 * Builds the MCP HTTP application from files + env (not listening yet):
 * catalog, users.yaml v2 (a v1 file aborts here) and the admin bootstrap,
 * which needs the identity provider (failing it aborts startup).
 */
export async function buildServer(config: AppConfig): Promise<StartedServer> {
  const { circuitRegistry, rolePolicy } = loadCatalog(config);
  const databases = DatabaseRegistry.fromEnv();
  const users = new YamlUserRepository(config.usersFile);
  const audit = new JsonLinesAuditLogger(config.auditLogFile);
  const identityProvider = new Auth0IdentityProvider({
    domain: config.auth.domain,
    clientId: config.auth.managementClientId,
    clientSecret: config.auth.managementClientSecret,
    connection: config.auth.dbConnection,
    mcpAudience: config.auth.mcpResourceUrl,
    passwordLinkTtlSeconds: config.auth.passwordLinkTtlSeconds,
  });

  const knownUsers = await users.list();
  const bootstrapped = await new BootstrapAdminsUseCase({ users, identityProvider, audit, newId: randomUUID }).execute(
    config.auth.bootstrapAdminEmails,
  );

  const app = createApplication({
    circuitRegistry,
    rolePolicy,
    users,
    databases,
    tokens: new JwtAccessTokenVerifier({
      issuer: config.auth.issuer,
      audiences: { mcp: config.auth.mcpResourceUrl, admin: config.auth.adminApiAudience },
    }),
    identityProvider,
    mcpResourceUrl: config.auth.mcpResourceUrl,
    sqlQueryLimits: config.sqlQueryLimits,
    rateLimit: config.rateLimit,
    dbPoolMax: config.dbPoolMax,
    audit,
  });

  const summary =
    `${circuitRegistry.ids().length} circuits, ${rolePolicy.roles.size} roles, ` +
    `${knownUsers.length + bootstrapped} users${bootstrapped ? ` (${bootstrapped} bootstrapped admins)` : ''}, ` +
    `issuer: ${config.auth.issuer}, databases: ${databases.keys().join(', ') || 'none'}`;
  return { app, summary };
}
