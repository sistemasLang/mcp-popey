import pg from 'pg';
import type { DatabaseRegistry } from './database.registry.js';

const DATE_OID = 1082;

/**
 * Return DATE columns as 'YYYY-MM-DD' strings. The default parser builds a
 * local-midnight Date, which serializes to the previous day in UTC-3.
 */
export const typeParsers = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    oid === DATE_OID ? (value: string) => value : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
};

export interface PoolManagerOptions {
  maxConnections: number;
  statementTimeoutMs: number;
}

/**
 * One pg.Pool per databaseKey, created on first use and then reused.
 * Tool calls borrow a client from the pool; they never open a connection.
 */
export class PoolManager {
  private readonly pools = new Map<string, pg.Pool>();

  constructor(
    private readonly registry: DatabaseRegistry,
    private readonly options: PoolManagerOptions,
  ) {}

  getPool(databaseKey: string): pg.Pool {
    const existing = this.pools.get(databaseKey);
    if (existing) return existing;

    const config = this.registry.get(databaseKey);
    const pool = new pg.Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      // Encrypted but not identity-verified (like libpq sslmode=require): tenant
      // servers use self-signed certificates.
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      max: this.options.maxConnections,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: 'mcp-popey',
      statement_timeout: this.options.statementTimeoutMs,
      // Every session starts read-only; DatabaseAdapter also opens READ ONLY transactions.
      options: '-c default_transaction_read_only=on',
      types: typeParsers,
    });
    // An idle client error must not crash the process; the pool discards that client.
    pool.on('error', () => {});
    this.pools.set(databaseKey, pool);
    return pool;
  }

  async closeAll(): Promise<void> {
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.allSettled(pools.map((pool) => pool.end()));
  }
}
