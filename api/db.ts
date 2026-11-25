import pg from 'pg';
import Cursor from 'pg-cursor';
import type { DatabaseConfig } from './config.js';
import { AppError, logInternalError, redactCredentials, type SqlDiagnostics } from './errors.js';

/**
 * Runs the SQL written by the AI. The SQL is never parsed nor rewritten: PostgreSQL
 * itself guarantees it can only read, with three independent barriers:
 *   1. Every statement runs inside `BEGIN READ ONLY ... ROLLBACK`.
 *   2. It runs through a cursor (extended protocol), which accepts ONE statement only,
 *      so `COMMIT; DELETE ...` cannot escape the read-only transaction.
 *   3. The connection uses the role mcp_popey_ro, which only has SELECT grants
 *      (scripts/create_readonly_role.sql).
 */

export interface SqlResult {
  /** Column names in the order the statement returns them. */
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  /** There were more than maxRows rows; only maxRows were returned. */
  truncated: boolean;
}

export type RunSql = (databaseKey: string, sql: string) => Promise<SqlResult>;

const DATE_OID = 1082;

/** DATE as 'YYYY-MM-DD'. The default parser builds a local-midnight Date that shows the previous day in UTC-3. */
const types = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    oid === DATE_OID ? (value: string) => value : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
};

export function createDatabase(options: {
  databases: Map<string, DatabaseConfig>;
  poolMax: number;
  maxRows: number;
  timeoutMs: number;
}) {
  /** One pool per tenant, created on first use. */
  const pools = new Map<string, pg.Pool>();

  function poolFor(databaseKey: string): pg.Pool {
    const existing = pools.get(databaseKey);
    if (existing) return existing;
    const config = options.databases.get(databaseKey);
    if (!config) throw new AppError('DATABASE_QUERY_ERROR', 'No database is configured for this user');

    const pool = new pg.Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      // Encrypted but not identity-verified (libpq sslmode=require): tenant servers use self-signed certificates.
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      max: options.poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: 'mcp-popey',
      statement_timeout: options.timeoutMs,
      options: '-c default_transaction_read_only=on',
      types,
    });
    pool.on('error', () => {}); // an idle client dying must not crash the process
    pools.set(databaseKey, pool);
    return pool;
  }

  const runSql: RunSql = async (databaseKey, sql) => {
    const pool = poolFor(databaseKey);
    let client: pg.PoolClient;
    try {
      client = await pool.connect();
    } catch (error) {
      logInternalError(error);
      throw new AppError('DATABASE_QUERY_ERROR', 'The database is not available');
    }

    let broken = false;
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${Math.trunc(options.timeoutMs)}`);
      // The cursor does not inherit the pool's type parsers: pass them explicitly.
      const cursor = client.query(new Cursor(sql, undefined, { types }));
      try {
        // Read one row more than allowed, just to know whether there were more.
        const { rows, columns } = await read(cursor, options.maxRows + 1);
        const truncated = rows.length > options.maxRows;
        const returned = truncated ? rows.slice(0, options.maxRows) : rows;
        return { columns, rows: returned, rowCount: returned.length, truncated };
      } finally {
        await cursor.close().catch(() => {});
      }
    } catch (error) {
      logInternalError(error);
      broken = !(error instanceof pg.DatabaseError);
      throw toSqlError(error);
    } finally {
      try {
        await client.query('ROLLBACK'); // also reverts any SET / set_config() the statement made
      } catch {
        broken = true;
      }
      client.release(broken);
    }
  };

  async function close(): Promise<void> {
    const all = [...pools.values()];
    pools.clear();
    await Promise.allSettled(all.map((pool) => pool.end()));
  }

  return { runSql, close, poolFor };
}

function read(cursor: Cursor, maxRows: number): Promise<{ rows: Record<string, unknown>[]; columns: string[] }> {
  return new Promise((resolve, reject) => {
    cursor.read(maxRows, (error, rows, result) => {
      if (error) reject(error);
      else resolve({ rows: rows as Record<string, unknown>[], columns: (result?.fields ?? []).map((field) => field.name) });
    });
  });
}

/**
 * PostgreSQL error → public code + PostgreSQL's diagnosis (so the AI can fix its SQL).
 * A broken socket or any non-PostgreSQL error stays generic, without diagnostics.
 */
export function toSqlError(error: unknown): AppError {
  if (!(error instanceof pg.DatabaseError)) {
    return new AppError('DATABASE_QUERY_ERROR', 'The database could not execute the query');
  }
  const code = error.code ?? '';
  const diagnostics: SqlDiagnostics = {
    sqlState: code,
    message: redactCredentials(error.message),
    ...(error.hint ? { hint: redactCredentials(error.hint) } : {}),
    ...(error.position ? { position: Number(error.position) } : {}),
  };
  if (code === '57014') return new AppError('QUERY_TIMEOUT', 'The query exceeded the time limit', diagnostics);
  if (code.startsWith('22')) return new AppError('INVALID_QUERY', 'A value is not valid for its type', diagnostics);
  if (code === '42501') return new AppError('AUTHORIZATION_ERROR', 'The database denied access to this table', diagnostics);
  if (code === '42P01' || code === '42703') {
    return new AppError('DATABASE_QUERY_ERROR', 'A table or column in the statement does not exist in this database', diagnostics);
  }
  if (code === '42883') return new AppError('INVALID_QUERY', 'This operator is not supported for the column type', diagnostics);
  return new AppError('DATABASE_QUERY_ERROR', 'The database could not execute the query', diagnostics);
}
