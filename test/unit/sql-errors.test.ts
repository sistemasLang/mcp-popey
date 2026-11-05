import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresDatabaseAdapter } from '../../src/database/database.adapter.js';
import type { PoolManager } from '../../src/database/pool.manager.js';
import { AppError } from '../../src/errors/app-errors.js';
import { toPublicError } from '../../src/errors/error-mapper.js';

function pgError(code: string, message: string, extra: { hint?: string; position?: string } = {}): pg.DatabaseError {
  const error = new pg.DatabaseError(message, 0, 'error');
  error.code = code;
  if (extra.hint) error.hint = extra.hint;
  if (extra.position) error.position = extra.position;
  return error;
}

/** A pool whose client fails the user statement (not BEGIN/SET/ROLLBACK) with `failure`. */
function adapterFailingWith(failure: unknown, { connectFails = false } = {}): PostgresDatabaseAdapter {
  const client = {
    query: (statement: unknown) => {
      if (typeof statement === 'string') return Promise.resolve({ rows: [] });
      // A cursor (query_sql) is a submittable: pg returns it synchronously, and it fails on read().
      if (typeof statement === 'object' && statement !== null && 'read' in statement) {
        return { read: (_rows: number, callback: (error: unknown) => void) => callback(failure), close: async () => {} };
      }
      return Promise.reject(failure);
    },
    release: () => {},
  };
  const pools = {
    getPool: () => ({
      connect: async () => {
        if (connectFails) throw failure;
        return client;
      },
    }),
  } as unknown as PoolManager;
  return new PostgresDatabaseAdapter(pools);
}

async function publicErrorOf(adapter: PostgresDatabaseAdapter) {
  const error = await adapter.executeSql('a', 'SELECT 1', { timeoutMs: 1_000, maxRows: 10 }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AppError);
  return toPublicError(error, () => {});
}

describe('query_sql error mapping', () => {
  it('syntax error: public code plus PostgreSQL diagnostics', async () => {
    const outcome = await publicErrorOf(adapterFailingWith(pgError('42601', 'syntax error at or near "SELEC"', { position: '1' })));
    expect(outcome).toEqual({
      code: 'DATABASE_QUERY_ERROR',
      message: 'The database could not execute the query',
      diagnostics: { sqlState: '42601', message: 'syntax error at or near "SELEC"', position: 1 },
    });
  });

  it('permission denied → AUTHORIZATION_ERROR with diagnostics', async () => {
    const outcome = await publicErrorOf(adapterFailingWith(pgError('42501', 'permission denied for table usuario')));
    expect(outcome).toMatchObject({ code: 'AUTHORIZATION_ERROR', diagnostics: { sqlState: '42501', message: 'permission denied for table usuario' } });
  });

  it('timeout → QUERY_TIMEOUT with diagnostics', async () => {
    const outcome = await publicErrorOf(adapterFailingWith(pgError('57014', 'canceling statement due to statement timeout')));
    expect(outcome).toMatchObject({ code: 'QUERY_TIMEOUT', diagnostics: { sqlState: '57014' } });
  });

  it('keeps the hint and redacts credentials in any exposed text', async () => {
    const outcome = await publicErrorOf(
      adapterFailingWith(
        pgError('42703', 'column "x" does not exist near postgres://u:s3cret@h/db', { hint: 'Perhaps you meant "y". postgres://u:s3cret@h/db' }),
      ),
    );
    expect(outcome.diagnostics?.hint).toContain('Perhaps you meant "y"');
    expect(JSON.stringify(outcome)).not.toContain('s3cret');
  });

  it('a broken socket is generic, without diagnostics', async () => {
    const outcome = await publicErrorOf(adapterFailingWith(new Error('Connection terminated unexpectedly')));
    expect(outcome).toEqual({ code: 'DATABASE_QUERY_ERROR', message: 'The database could not execute the query' });
  });

  it('a database that is down is generic, without diagnostics', async () => {
    const outcome = await publicErrorOf(adapterFailingWith(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { connectFails: true }));
    expect(outcome).toEqual({ code: 'DATABASE_QUERY_ERROR', message: 'The database is not available' });
  });

  it('query_circuit keeps curated messages only, never diagnostics', async () => {
    const adapter = adapterFailingWith(pgError('42601', 'syntax error'));
    const error = await adapter.executeSelect('a', 'SELECT 1', [], { timeoutMs: 1_000 }).catch((caught: unknown) => caught);
    expect(toPublicError(error, () => {})).toEqual({ code: 'DATABASE_QUERY_ERROR', message: 'The database could not execute the query' });
  });
});
