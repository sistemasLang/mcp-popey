import type { Server } from 'node:http';
import type { AuditLogger } from './audit/audit.logger.js';
import { AuthMiddleware } from './auth/auth.middleware.js';
import { TokenVerifier } from './auth/token-verifier.js';
import { CircuitPolicyService } from './circuits/circuit-policy.service.js';
import type { CircuitRegistry } from './circuits/circuit.registry.js';
import { type DatabaseAdapter, PostgresDatabaseAdapter } from './database/database.adapter.js';
import type { DatabaseRegistry } from './database/database.registry.js';
import { PoolManager } from './database/pool.manager.js';
import { logInternalError } from './errors/error-mapper.js';
import { createHttpServer } from './mcp/http-server.js';
import { AuthorizationService } from './permissions/authorization.service.js';
import type { RolePolicy } from './permissions/role-policy.types.js';
import { QueryCompiler } from './query/query.compiler.js';
import { QueryExecutor } from './query/query.executor.js';
import { QueryValidator } from './query/query.validator.js';
import { SQL_QUERY_LIMITS, type QueryLimits, type SqlQueryLimits } from './security/query-limits.js';
import { RateLimiter } from './security/rate-limiter.js';
import { SqlExecutor } from './sql/sql.executor.js';
import type { UserRepository } from './users/user.repository.js';

export interface ApplicationOptions {
  circuitRegistry: CircuitRegistry;
  rolePolicy: RolePolicy;
  users: UserRepository;
  databases: DatabaseRegistry;
  queryLimits: QueryLimits;
  /** query_sql limits; defaults to SQL_QUERY_LIMITS. */
  sqlQueryLimits?: SqlQueryLimits;
  rateLimit: { maxRequests: number; windowMs: number };
  dbPoolMax: number;
  audit: AuditLogger;
  /** Overrides the PostgreSQL adapter (tests). */
  databaseAdapter?: DatabaseAdapter;
}

export interface Application {
  httpServer: Server;
  close(): Promise<void>;
}

/** Composition root: wires every component. No I/O besides what the inputs do. */
export function createApplication(options: ApplicationOptions): Application {
  const authorization = new AuthorizationService(options.rolePolicy, options.circuitRegistry);
  const circuits = new CircuitPolicyService(options.circuitRegistry, authorization);

  const pools = new PoolManager(options.databases, {
    maxConnections: options.dbPoolMax,
    statementTimeoutMs: options.queryLimits.timeoutMs,
  });
  const database = options.databaseAdapter ?? new PostgresDatabaseAdapter(pools, logInternalError);
  const sqlQueryLimits = options.sqlQueryLimits ?? SQL_QUERY_LIMITS;

  const httpServer = createHttpServer(new AuthMiddleware(new TokenVerifier(options.users), options.users), {
    circuits,
    validator: new QueryValidator(circuits, options.queryLimits),
    executor: new QueryExecutor(new QueryCompiler(), database, options.queryLimits.timeoutMs),
    rateLimiter: new RateLimiter(options.rateLimit),
    audit: options.audit,
    rolePolicy: options.rolePolicy,
    sqlExecutor: new SqlExecutor(database, sqlQueryLimits),
    sqlQueryLimits,
  });

  return {
    httpServer,
    async close() {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await pools.closeAll();
    },
  };
}
