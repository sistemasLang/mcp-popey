import type { UserContext } from '../auth/user-context.js';
import type { DatabaseAdapter } from '../database/database.adapter.js';
import type { SqlResult } from '../database/database.types.js';
import type { SqlQueryLimits } from '../security/query-limits.js';

/**
 * query_sql → DatabaseAdapter. Like QueryExecutor, the target database is
 * always UserContext.databaseKey; the SQL cannot choose another one.
 */
export class SqlExecutor {
  constructor(
    private readonly database: DatabaseAdapter,
    private readonly limits: SqlQueryLimits,
  ) {}

  execute(user: UserContext, sql: string): Promise<SqlResult> {
    return this.database.executeSql(user.databaseKey, sql, {
      timeoutMs: this.limits.timeoutMs,
      maxRows: this.limits.maxRows,
    });
  }
}
