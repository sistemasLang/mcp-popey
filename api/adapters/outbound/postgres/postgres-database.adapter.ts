import pg from 'pg';
import Cursor from 'pg-cursor';
import {
  AuthorizationError,
  DatabaseQueryError,
  InvalidQueryError,
  QueryTimeoutError,
  type SqlDiagnostics,
} from '../../../domain/errors.js';
import type { InternalErrorLogger } from '../../../application/ports/outbound/internal-error-log.port.js';
import { redactCredentials } from '../logging/stderr-internal-error.logger.js';
import type { ReadOnlyDatabasePort, SqlOptions, SqlResult } from '../../../application/ports/outbound/database.port.js';
import { typeParsers, type PoolManager } from './pool.manager.js';

const QUERY_CANCELED = '57014';
const INSUFFICIENT_PRIVILEGE = '42501';
const UNDEFINED_TABLE = '42P01';
const UNDEFINED_COLUMN = '42703';
const UNDEFINED_FUNCTION = '42883';

/**
 * PostgreSQL implementation: DatabaseRegistry → PoolManager → pg.
 * Every statement runs inside `BEGIN READ ONLY ... ROLLBACK`, so even a role
 * with write grants could not modify data through this path.
 */
export class PostgresDatabaseAdapter implements ReadOnlyDatabasePort {
  constructor(
    private readonly pools: PoolManager,
    private readonly logInternalError: InternalErrorLogger = () => {},
  ) {}

  /**
   * A cursor uses the extended protocol (Parse/Bind/Execute), so PostgreSQL
   * rejects more than one statement: `COMMIT; ...` cannot leave the READ ONLY
   * transaction. It also reads only maxRows + 1 rows, never the whole result.
   */
  executeSql(databaseKey: string, sql: string, options: SqlOptions): Promise<SqlResult> {
    return this.inReadOnlyTransaction(databaseKey, options.timeoutMs, async (client) => {
      // The cursor does not inherit the pool's type parsers: pass them explicitly (DATE as text).
      const cursor = client.query(new Cursor(sql, undefined, { types: typeParsers }));
      try {
        const { rows, fields } = await readCursor(cursor, options.maxRows + 1);
        const truncated = rows.length > options.maxRows;
        const returned = truncated ? rows.slice(0, options.maxRows) : rows;
        return { columns: fields, rows: returned, rowCount: returned.length, truncated };
      } finally {
        await cursor.close().catch(() => {});
      }
    });
  }

  private async inReadOnlyTransaction<T>(
    databaseKey: string,
    timeoutMs: number,
    run: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const pool = this.pools.getPool(databaseKey);

    let client: pg.PoolClient;
    try {
      client = await pool.connect();
    } catch (error) {
      this.logInternalError(error);
      throw new DatabaseQueryError('The database is not available');
    }

    let broken = false;
    try {
      await client.query('BEGIN READ ONLY');
      // Integer from server config, never from the request.
      await client.query(`SET LOCAL statement_timeout = ${Math.trunc(timeoutMs)}`);
      return await run(client);
    } catch (error) {
      this.logInternalError(error);
      broken = !isPgError(error);
      throw toSqlError(error);
    } finally {
      try {
        // Also reverts any SET / set_config() the statement made.
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      client.release(broken);
    }
  }
}

function readCursor(cursor: Cursor, maxRows: number): Promise<{ rows: Record<string, unknown>[]; fields: string[] }> {
  return new Promise((resolve, reject) => {
    cursor.read(maxRows, (error, rows, result) => {
      if (error) reject(error);
      else resolve({ rows: rows as Record<string, unknown>[], fields: (result?.fields ?? []).map((field) => field.name) });
    });
  });
}

/** Public code and message by SQLSTATE; PostgreSQL's diagnosis travels apart, in `diagnostics`. */
function toSafeError(error: unknown, diagnostics?: SqlDiagnostics): Error {
  const options = diagnostics ? { diagnostics } : undefined;
  if (!isPgError(error)) return new DatabaseQueryError('The database could not execute the query');
  const code = error.code ?? '';
  if (code === QUERY_CANCELED) return new QueryTimeoutError('The query exceeded the time limit', options);
  if (code.startsWith('22')) return new InvalidQueryError('A value is not valid for its type', options);
  if (code === INSUFFICIENT_PRIVILEGE) return new AuthorizationError('The database denied access to this table', options);
  if (code === UNDEFINED_TABLE || code === UNDEFINED_COLUMN) {
    return new DatabaseQueryError('A table or column in the statement does not exist in this database', options);
  }
  if (code === UNDEFINED_FUNCTION) {
    return new InvalidQueryError('This operator is not supported for the column type', options);
  }
  return new DatabaseQueryError('The database could not execute the query', options);
}

/**
 * Public code by SQLSTATE plus PostgreSQL's diagnosis so the model can fix its
 * own SQL. Only for errors PostgreSQL returned; connection errors stay generic.
 */
function toSqlError(error: unknown): Error {
  if (!isPgError(error)) return toSafeError(error);
  const diagnostics: SqlDiagnostics = {
    sqlState: error.code ?? '',
    message: redactCredentials(error.message),
    ...(error.hint ? { hint: redactCredentials(error.hint) } : {}),
    ...(error.position ? { position: Number(error.position) } : {}),
  };
  return toSafeError(error, diagnostics);
}

/** An error reported by the server (SQLSTATE), as opposed to a broken socket. */
function isPgError(error: unknown): error is pg.DatabaseError {
  return error instanceof pg.DatabaseError;
}
