import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createHttpServer } from '../adapters/inbound/http/http-server.js';
import { logInternalError } from '../adapters/outbound/logging/stderr-internal-error.logger.js';
import { SlidingWindowRateLimiter } from '../adapters/outbound/memory/sliding-window.rate-limiter.js';
import type { DatabaseRegistry } from '../adapters/outbound/postgres/database.registry.js';
import { PoolManager } from '../adapters/outbound/postgres/pool.manager.js';
import { PostgresDatabaseAdapter } from '../adapters/outbound/postgres/postgres-database.adapter.js';
import type { AccessTokenVerifier } from '../application/ports/inbound/access-token-verifier.port.js';
import type { AuditLogger } from '../application/ports/outbound/audit-log.port.js';
import type { ReadOnlyDatabasePort } from '../application/ports/outbound/database.port.js';
import type { IdentityProviderPort } from '../application/ports/outbound/identity-provider.port.js';
import type { UserAdminRepository, UserRepository } from '../application/ports/outbound/user-repository.port.js';
import { AuthorizationService } from '../application/services/authorization.service.js';
import { CircuitPolicyService } from '../application/services/circuit-policy.service.js';
import { AdminUsersUseCase } from '../application/use-cases/admin-users.use-case.js';
import { AuthenticateUserUseCase } from '../application/use-cases/authenticate-user.use-case.js';
import { DescribeCircuitUseCase, ListCircuitsUseCase } from '../application/use-cases/circuit-catalog.use-cases.js';
import { QuerySqlUseCase } from '../application/use-cases/query-sql.use-case.js';
import type { CircuitRegistry } from '../domain/circuits/circuit.registry.js';
import type { RolePolicy } from '../domain/role-policy.js';
import { SQL_QUERY_LIMITS, type SqlQueryLimits } from '../domain/security/query-limits.js';

export interface ApplicationOptions {
  circuitRegistry: CircuitRegistry;
  rolePolicy: RolePolicy;
  users: UserRepository & UserAdminRepository;
  databases: DatabaseRegistry;
  /** Turns bearer tokens into verified `(issuer, subject)` pairs. */
  tokens: AccessTokenVerifier;
  identityProvider: IdentityProviderPort;
  /** MCP_RESOURCE_URL, announced in the protected resource metadata. */
  mcpResourceUrl: string;
  /** query_sql limits; defaults to SQL_QUERY_LIMITS. */
  sqlQueryLimits?: SqlQueryLimits;
  rateLimit: { maxRequests: number; windowMs: number };
  dbPoolMax: number;
  audit: AuditLogger;
  /** Replaces the PostgreSQL adapter (tests). */
  database?: ReadOnlyDatabasePort;
}

export interface Application {
  httpServer: Server;
  close(): Promise<void>;
}

/**
 * Composition root: the only place that binds adapters to ports and builds
 * the use cases. No I/O besides what the given adapters do.
 */
export function createApplication(options: ApplicationOptions): Application {
  const sqlQueryLimits = options.sqlQueryLimits ?? SQL_QUERY_LIMITS;

  // Outbound adapters.
  const pools = new PoolManager(options.databases, {
    maxConnections: options.dbPoolMax,
    statementTimeoutMs: sqlQueryLimits.timeoutMs,
  });
  const database = options.database ?? new PostgresDatabaseAdapter(pools, logInternalError);
  const rateLimiter = new SlidingWindowRateLimiter(options.rateLimit);

  // Application services.
  const authorization = new AuthorizationService(options.rolePolicy, options.circuitRegistry);
  const circuits = new CircuitPolicyService(options.circuitRegistry, authorization);

  // Use cases.
  const authenticateUser = new AuthenticateUserUseCase(options.users);
  const adminUsers = new AdminUsersUseCase({
    users: options.users,
    identityProvider: options.identityProvider,
    rolePolicy: options.rolePolicy,
    databaseKeys: options.databases.keys(),
    audit: options.audit,
    logInternalError,
    newId: randomUUID,
  });
  const listCircuits = new ListCircuitsUseCase(circuits);
  const describeCircuit = new DescribeCircuitUseCase(circuits);
  const querySql = new QuerySqlUseCase(authorization, rateLimiter, database, sqlQueryLimits);

  // Inbound adapters.
  const httpServer = createHttpServer({
    tokens: options.tokens,
    authenticateUser,
    adminUsers,
    resource: { url: options.mcpResourceUrl, authorizationServer: options.identityProvider.issuer },
    mcp: {
      listCircuits,
      describeCircuit,
      querySql,
      authorization,
      audit: options.audit,
      logInternalError,
    },
    logInternalError,
  });

  return {
    httpServer,
    async close() {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await pools.closeAll();
    },
  };
}
