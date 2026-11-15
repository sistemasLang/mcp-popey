import type { ReadOnlyDatabasePort } from '../ports/outbound/database.port.js';
import type { RateLimiterPort } from '../ports/outbound/rate-limiter.port.js';
import type { QueryValidator } from '../services/query.validator.js';
import type { QueryCompiler } from '../../domain/query/query.compiler.js';
import type { QueryCircuitRequest } from '../../domain/query/query.types.js';
import type { UserContext } from '../../domain/user-context.js';

export interface QueryCircuitResult {
  circuit: string;
  table: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  limit: number;
}

/**
 * query_circuit: RateLimiter → QueryValidator (authorization + catalog rules)
 * → QueryCompiler → ReadOnlyDatabasePort. The target database is always
 * UserContext.databaseKey; this use case has no other way to pick one.
 */
export class QueryCircuitUseCase {
  constructor(
    private readonly rateLimiter: RateLimiterPort,
    private readonly validator: QueryValidator,
    private readonly compiler: QueryCompiler,
    private readonly database: ReadOnlyDatabasePort,
    private readonly timeoutMs: number,
  ) {}

  async execute(user: UserContext, request: QueryCircuitRequest): Promise<QueryCircuitResult> {
    this.rateLimiter.consume(user.userId);
    const query = this.validator.validate(user, request);
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
