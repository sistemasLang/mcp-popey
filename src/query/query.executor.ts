import type { UserContext } from '../auth/user-context.js';
import type { DatabaseAdapter } from '../database/database.adapter.js';
import type { QueryCompiler } from './query.compiler.js';
import type { ValidatedQuery } from './query.types.js';

export interface QueryResult {
  circuit: string;
  table: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  limit: number;
}

/**
 * ValidatedQuery → QueryCompiler → DatabaseAdapter. The target database is
 * always UserContext.databaseKey; this class has no other way to pick one.
 */
export class QueryExecutor {
  constructor(
    private readonly compiler: QueryCompiler,
    private readonly database: DatabaseAdapter,
    private readonly timeoutMs: number,
  ) {}

  async execute(user: UserContext, query: ValidatedQuery): Promise<QueryResult> {
    const compiled = this.compiler.compile(query);
    const result = await this.database.executeSelect(user.databaseKey, compiled.sql, compiled.params, {
      timeoutMs: this.timeoutMs,
    });
    return {
      circuit: query.circuit,
      table: query.table.qualifiedName,
      columns: query.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      limit: query.limit,
    };
  }
}
