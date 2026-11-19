import type { ReadOnlyDatabasePort, SqlResult } from '../ports/outbound/database.port.js';
import type { RateLimiterPort } from '../ports/outbound/rate-limiter.port.js';
import type { AuthorizationService } from '../services/authorization.service.js';
import { AuthorizationError } from '../../domain/errors.js';
import type { SqlQueryLimits } from '../../domain/security/query-limits.js';
import type { UserContext } from '../../domain/user-context.js';

/**
 * query_sql: role check → RateLimiter → ReadOnlyDatabasePort. The SQL is
 * never parsed nor rewritten; read-only is enforced by the database adapter
 * (READ ONLY transaction, single statement) and the PostgreSQL role grants.
 * The target database is always UserContext.databaseKey; there is no other way to pick one.
 */
export class QuerySqlUseCase {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly rateLimiter: RateLimiterPort,
    private readonly database: ReadOnlyDatabasePort,
    readonly limits: SqlQueryLimits,
  ) {}

  execute(user: UserContext, sql: string): Promise<SqlResult> {
    // The MCP adapter does not even list the tool for these roles; checked again on purpose.
    if (!this.authorization.canUseSql(user)) {
      throw new AuthorizationError('query_sql is not available for this role');
    }
    this.rateLimiter.consume(user.userId);
    return this.database.executeSql(user.databaseKey, sql, {
      timeoutMs: this.limits.timeoutMs,
      maxRows: this.limits.maxRows,
    });
  }
}
