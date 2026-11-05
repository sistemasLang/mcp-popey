import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Client as McpClient } from '@modelcontextprotocol/client';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDatabaseAdapter } from '../../src/database/database.adapter.js';
import { DatabaseRegistry } from '../../src/database/database.registry.js';
import type { DatabaseConfig } from '../../src/database/database.types.js';
import { PoolManager } from '../../src/database/pool.manager.js';
import { AuthorizationError, DatabaseQueryError, QueryTimeoutError, type AppError } from '../../src/errors/app-errors.js';
import { callTool, connectClient, makeUser, startTestApp, type TestApp } from '../e2e-harness.js';

/**
 * Real PostgreSQL (disposable container): two tenant databases with different
 * data, the MCP connecting as mcp_popey_ro with the minimum grants of §22.
 */
const RO_PASSWORD = 'ro_test_password';
const TENANTS = ['tenant_a', 'tenant_b'] as const;

const ROLE_SCRIPT = fileURLToPath(new URL('../../scripts/create_readonly_role.sql', import.meta.url));

// Every schema the role script grants must exist.
// Note: bpagada is documented in circuits.yaml but intentionally missing here.
const SCHEMA_SQL = `
  CREATE SCHEMA stock;
  CREATE SCHEMA compra;
  CREATE SCHEMA seguridad;
  CREATE SCHEMA administracion;
  CREATE SCHEMA e_plataforma;
  CREATE SCHEMA ecommerce;
  CREATE SCHEMA mercado_libre;
  CREATE SCHEMA servicio_tecnico;
  CREATE SCHEMA util;
  CREATE SCHEMA venta;
  CREATE TABLE stock.factura_venta (
    nfacturaventa int PRIMARY KEY, ncliente int, vnumero varchar, dfecha date, ndeposito int,
    ftotal numeric(12,2), ntipocomprobante int, nestadofactura int, nlistaprecio int, vafip_cae varchar,
    nrazonsocial int, ncarritoventa int, ftotaliibb numeric(12,2), nestadonc int,
    vsecreto varchar
  );
  CREATE TABLE compra.orden_compra (nordencompra int PRIMARY KEY, ftotal numeric(12,2));
  CREATE TABLE seguridad.usuario (nusuario int, vnombre varchar, vapellido varchar, vusuario varchar, vpassword varchar, vcodigo2fa varchar);
  INSERT INTO seguridad.usuario VALUES (1, 'Ada', 'Lovelace', 'admin', 'hash-should-never-leak', '123456');
  -- Owned by the superuser and SECURITY DEFINER: privileges would allow the write; only READ ONLY stops it.
  CREATE FUNCTION util.write_side_effect() RETURNS int LANGUAGE sql SECURITY DEFINER AS
    $$ INSERT INTO stock.factura_venta (nfacturaventa) VALUES (777) RETURNING 1 $$;
`;

const DATA_SQL: Record<(typeof TENANTS)[number], string> = {
  tenant_a: `INSERT INTO stock.factura_venta (nfacturaventa, ncliente, vnumero, dfecha, ftotal, vsecreto) VALUES
    (1, 100, 'A-0001', '2026-10-01', 1000.00, 'secret-a'),
    (2, 101, 'A-0002', '2026-10-15', 2000.00, 'secret-a'),
    (3, 102, 'A-0003', '2026-09-30', 50.00,  'secret-a');`,
  tenant_b: `INSERT INTO stock.factura_venta (nfacturaventa, ncliente, vnumero, dfecha, ftotal, vsecreto) VALUES
    (1, 200, 'B-0001', '2026-10-05', 5000.00, 'secret-b');`,
};

let container: StartedPostgreSqlContainer;
let superConfig: (database: string) => DatabaseConfig;
let roConfig: (database: string) => DatabaseConfig;

async function runAsSuperuser(database: string, sql: string): Promise<void> {
  const client = new pg.Client(superConfig(database));
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withCopyFilesToContainer([{ source: ROLE_SCRIPT, target: '/tmp/create_readonly_role.sql' }])
    .start();
  const base = { host: container.getHost(), port: container.getPort(), ssl: false };
  superConfig = (database) => ({ ...base, database, user: container.getUsername(), password: container.getPassword() });
  roConfig = (database) => ({ ...base, database, user: 'mcp_popey_ro', password: RO_PASSWORD });

  for (const tenant of TENANTS) {
    await runAsSuperuser(container.getDatabase(), `CREATE DATABASE ${tenant}`);
    await runAsSuperuser(tenant, SCHEMA_SQL + DATA_SQL[tenant]);
    // The production script, unchanged, is what grants mcp_popey_ro its privileges.
    const result = await container.exec([
      'psql', '-U', container.getUsername(), '-d', tenant, '-v', 'ON_ERROR_STOP=1',
      '-v', `ro_password=${RO_PASSWORD}`, '-v', `owner_role=${container.getUsername()}`,
      '-f', '/tmp/create_readonly_role.sql',
    ]);
    if (result.exitCode !== 0) throw new Error(`create_readonly_role.sql failed:\n${result.output}`);
  }
});

afterAll(async () => {
  await container?.stop();
});

describe('multi-tenant through the MCP (HTTP, real PostgreSQL)', () => {
  const userA = makeUser('user-a', 'ventas', 'tenant_a');
  const userB = makeUser('user-b', 'ventas', 'tenant_b');
  let app: TestApp;
  let clientA: McpClient;
  let clientB: McpClient;

  const facturas = { circuit: 'venta', table: 'stock.factura_venta', select: ['nfacturaventa', 'vnumero', 'dfecha', 'ftotal'] };

  beforeAll(async () => {
    app = await startTestApp([userA, userB], {
      databases: DatabaseRegistry.fromConfigs({ tenant_a: roConfig('tenant_a'), tenant_b: roConfig('tenant_b') }),
    });
    clientA = await connectClient(app.url, userA.token);
    clientB = await connectClient(app.url, userB.token);
  });

  afterAll(async () => {
    await Promise.all([clientA?.close(), clientB?.close()]);
    await app?.close();
  });

  it('UserA sees only database A, UserB only database B', async () => {
    const a = await callTool(clientA, 'query_circuit', { ...facturas, orderBy: [{ field: 'nfacturaventa', direction: 'asc' }] });
    const b = await callTool(clientB, 'query_circuit', facturas);

    expect(a.isError).toBe(false);
    expect(a.data.rows.map((row: { vnumero: string }) => row.vnumero)).toEqual(['A-0001', 'A-0002', 'A-0003']);
    expect(b.data.rows.map((row: { vnumero: string }) => row.vnumero)).toEqual(['B-0001']);
  });

  it('the same filter returns each tenant its own data', async () => {
    const filter = { ...facturas, filters: [{ field: 'nfacturaventa', operator: 'eq', value: 1 }] };
    const a = await callTool(clientA, 'query_circuit', filter);
    const b = await callTool(clientB, 'query_circuit', filter);
    expect(a.data.rows[0]).toMatchObject({ vnumero: 'A-0001', ftotal: '1000.00' });
    expect(b.data.rows[0]).toMatchObject({ vnumero: 'B-0001', ftotal: '5000.00' });
  });

  it('a manual databaseKey cannot redirect UserA to B', async () => {
    const outcome = await callTool(clientA, 'query_circuit', { ...facturas, databaseKey: 'tenant_b' });
    expect(outcome.isError).toBe(true);
    expect(JSON.stringify(outcome.data)).not.toContain('B-0001');
  });

  it('DATE comes back as YYYY-MM-DD (no timezone shift)', async () => {
    const a = await callTool(clientA, 'query_circuit', { ...facturas, filters: [{ field: 'nfacturaventa', operator: 'eq', value: 1 }] });
    expect(a.data.rows[0].dfecha).toBe('2026-10-01');
  });

  it('operators work against PostgreSQL', async () => {
    const run = async (filters: unknown[], orderBy?: unknown[]) =>
      (await callTool(clientA, 'query_circuit', { ...facturas, filters, orderBy })).data.rows.map(
        (row: { vnumero: string }) => row.vnumero,
      );

    expect(await run([{ field: 'dfecha', operator: 'gte', value: '2026-10-01' }], [{ field: 'dfecha', direction: 'asc' }])).toEqual(['A-0001', 'A-0002']);
    expect(await run([{ field: 'ncliente', operator: 'in', value: [100, 102] }], [{ field: 'ncliente', direction: 'desc' }])).toEqual(['A-0003', 'A-0001']);
    expect(await run([{ field: 'vnumero', operator: 'contains', value: '0002' }])).toEqual(['A-0002']);
    expect(await run([{ field: 'vnumero', operator: 'startsWith', value: 'a-' }])).toHaveLength(3);
    expect(await run([{ field: 'vnumero', operator: 'contains', value: '%' }])).toEqual([]);
    expect(await run([{ field: 'vafip_cae', operator: 'isNull' }])).toHaveLength(3);
    expect(await run([{ field: 'ftotal', operator: 'lt', value: 100 }])).toEqual(['A-0003']);
  });

  it('LIMIT is applied', async () => {
    const a = await callTool(clientA, 'query_circuit', { ...facturas, limit: 2 });
    expect(a.data.rows).toHaveLength(2);
    expect(a.data.limit).toBe(2);
  });

  it('a column that exists in the table but not in key_columns is not reachable', async () => {
    const outcome = await callTool(clientA, 'query_circuit', { ...facturas, select: ['vsecreto'] });
    expect(outcome.data.error.code).toBe('COLUMN_NOT_ALLOWED');
  });

  it.each([
    "'; DROP TABLE stock.factura_venta; --",
    '1 OR 1=1',
    "A-0001' OR '1'='1",
    'x UNION SELECT vpassword FROM seguridad.usuario',
  ])('injection as a value is inert in PostgreSQL: %s', async (payload) => {
    const outcome = await callTool(clientA, 'query_circuit', {
      ...facturas,
      filters: [{ field: 'vnumero', operator: 'eq', value: payload }],
    });
    expect(outcome.isError).toBe(false);
    expect(outcome.data.rows).toEqual([]);

    const after = await callTool(clientA, 'query_circuit', facturas);
    expect(after.data.rows).toHaveLength(3);
  });

  it('a malformed value gets a curated error, not PostgreSQL text', async () => {
    const outcome = await callTool(clientA, 'query_circuit', {
      ...facturas,
      filters: [{ field: 'dfecha', operator: 'eq', value: 'not-a-date' }],
    });
    expect(outcome.data.error).toEqual({ code: 'INVALID_QUERY', message: 'A filter value is not valid for its column type' });
  });

  it('a documented column missing in the real table gets a curated error', async () => {
    const outcome = await callTool(clientA, 'query_circuit', { ...facturas, select: ['bpagada'] });
    expect(outcome.data.error.code).toBe('DATABASE_QUERY_ERROR');
    expect(outcome.data.error.message).toMatch(/does not exist in this database/);
    expect(JSON.stringify(outcome.data)).not.toMatch(/column .*bpagada.* does not exist|SELECT/);
  });
});

describe('mcp_popey_ro: PostgreSQL is the last barrier', () => {
  async function asReadOnly(sql: string): Promise<string | undefined> {
    const client = new pg.Client(roConfig('tenant_a'));
    await client.connect();
    try {
      await client.query(sql);
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    } finally {
      await client.end();
    }
  }

  it('reads the safe seguridad.usuario columns', async () => {
    expect(await asReadOnly('SELECT nusuario, vnombre, vapellido, vusuario FROM seguridad.usuario')).toBeUndefined();
  });

  it('cannot read sensitive seguridad.usuario columns, nor SELECT * (42501)', async () => {
    expect(await asReadOnly('SELECT vpassword FROM seguridad.usuario')).toBe('42501');
    expect(await asReadOnly('SELECT vcodigo2fa FROM seguridad.usuario')).toBe('42501');
    expect(await asReadOnly('SELECT * FROM seguridad.usuario')).toBe('42501');
    expect(await asReadOnly("SELECT nusuario FROM seguridad.usuario WHERE vpassword = 'x'")).toBe('42501');
  });

  it('cannot write seguridad.usuario', async () => {
    expect(['25006', '42501']).toContain(await asReadOnly("INSERT INTO seguridad.usuario (nusuario) VALUES (2)"));
  });

  it('the role script is idempotent and keeps the column grants', async () => {
    for (let run = 0; run < 2; run++) {
      const result = await container.exec([
        'psql', '-U', container.getUsername(), '-d', 'tenant_a', '-v', 'ON_ERROR_STOP=1',
        '-v', `ro_password=${RO_PASSWORD}`, '-v', `owner_role=${container.getUsername()}`,
        '-f', '/tmp/create_readonly_role.sql',
      ]);
      expect(result.exitCode, result.output).toBe(0);
    }
    expect(await asReadOnly('SELECT nusuario, vnombre FROM seguridad.usuario')).toBeUndefined();
    expect(await asReadOnly('SELECT vpassword FROM seguridad.usuario')).toBe('42501');
  });

  it('sessions start read-only by role default (set by the script)', async () => {
    const client = new pg.Client(roConfig('tenant_a'));
    await client.connect();
    try {
      const { rows } = await client.query('SHOW default_transaction_read_only');
      expect(rows[0]).toEqual({ default_transaction_read_only: 'on' });
    } finally {
      await client.end();
    }
  });

  it.each([
    ['INSERT', "INSERT INTO stock.factura_venta (nfacturaventa) VALUES (999)"],
    ['UPDATE', 'UPDATE stock.factura_venta SET ftotal = 0'],
    ['DELETE', 'DELETE FROM stock.factura_venta'],
    ['TRUNCATE', 'TRUNCATE stock.factura_venta'],
    ['CREATE', 'CREATE TABLE stock.x (id int)'],
    ['DROP', 'DROP TABLE stock.factura_venta'],
    ['ALTER', 'ALTER TABLE stock.factura_venta ADD COLUMN y int'],
  ])('cannot %s', async (_case, sql) => {
    // 25006 (read-only transaction) or 42501 (insufficient privilege): either way, denied.
    expect(['25006', '42501']).toContain(await asReadOnly(sql));
  });

  it('can SELECT granted tables', async () => {
    expect(await asReadOnly('SELECT nfacturaventa FROM stock.factura_venta')).toBeUndefined();
  });
});

describe('PostgresDatabaseAdapter barriers', () => {
  it('runs inside READ ONLY transactions even with a superuser', async () => {
    const pools = new PoolManager(DatabaseRegistry.fromConfigs({ owner: superConfig('tenant_a') }), {
      maxConnections: 1,
      statementTimeoutMs: 5_000,
    });
    const adapter = new PostgresDatabaseAdapter(pools);
    try {
      await expect(
        adapter.executeSelect('owner', "INSERT INTO stock.factura_venta (nfacturaventa) VALUES (999)", [], { timeoutMs: 5_000 }),
      ).rejects.toBeInstanceOf(DatabaseQueryError);
      const { rows } = await adapter.executeSelect('owner', 'SELECT count(*)::int AS n FROM stock.factura_venta', [], {
        timeoutMs: 5_000,
      });
      expect(rows[0]).toEqual({ n: 3 });
    } finally {
      await pools.closeAll();
    }
  });

  it('enforces the statement timeout', async () => {
    const pools = new PoolManager(DatabaseRegistry.fromConfigs({ a: roConfig('tenant_a') }), {
      maxConnections: 1,
      statementTimeoutMs: 5_000,
    });
    const adapter = new PostgresDatabaseAdapter(pools);
    try {
      await expect(adapter.executeSelect('a', 'SELECT pg_sleep(2)', [], { timeoutMs: 200 })).rejects.toBeInstanceOf(
        QueryTimeoutError,
      );
      // The pooled connection is still usable afterwards.
      const { rows } = await adapter.executeSelect('a', 'SELECT 1 AS ok', [], { timeoutMs: 1_000 });
      expect(rows).toEqual([{ ok: 1 }]);
    } finally {
      await pools.closeAll();
    }
  });

  it('reuses one pool per databaseKey', async () => {
    const pools = new PoolManager(DatabaseRegistry.fromConfigs({ a: roConfig('tenant_a'), b: roConfig('tenant_b') }), {
      maxConnections: 2,
      statementTimeoutMs: 5_000,
    });
    try {
      expect(pools.getPool('a')).toBe(pools.getPool('a'));
      expect(pools.getPool('a')).not.toBe(pools.getPool('b'));
      const adapter = new PostgresDatabaseAdapter(pools);
      await Promise.all(
        Array.from({ length: 10 }, () => adapter.executeSelect('a', 'SELECT 1', [], { timeoutMs: 1_000 })),
      );
      expect(pools.getPool('a').totalCount).toBeLessThanOrEqual(2);
    } finally {
      await pools.closeAll();
    }
  });
});

describe('PostgresDatabaseAdapter.executeSql (query_sql)', () => {
  let pools: PoolManager;
  let adapter: PostgresDatabaseAdapter;
  const options = { timeoutMs: 5_000, maxRows: 1_000 };
  const countFacturas = async () =>
    (await adapter.executeSql('a', 'SELECT count(*)::int AS n FROM stock.factura_venta', options)).rows[0];

  beforeAll(() => {
    // One connection: every call reuses the same session, so leaked session state would show.
    pools = new PoolManager(DatabaseRegistry.fromConfigs({ a: roConfig('tenant_a') }), {
      maxConnections: 1,
      statementTimeoutMs: 5_000,
    });
    adapter = new PostgresDatabaseAdapter(pools);
  });

  afterAll(async () => {
    await pools?.closeAll();
  });

  it('runs free SQL: joins, aggregates, CTEs', async () => {
    const result = await adapter.executeSql(
      'a',
      `WITH f AS (SELECT ncliente, ftotal FROM stock.factura_venta)
       SELECT count(*)::int AS facturas, sum(ftotal) AS total FROM f WHERE ftotal > 10`,
      options,
    );
    expect(result).toEqual({ columns: ['facturas', 'total'], rows: [{ facturas: 3, total: '3050.00' }], rowCount: 1, truncated: false });
  });

  it('returns columns in statement order and DATE as YYYY-MM-DD', async () => {
    const result = await adapter.executeSql('a', 'SELECT dfecha, vnumero FROM stock.factura_venta WHERE nfacturaventa = 1', options);
    expect(result.columns).toEqual(['dfecha', 'vnumero']);
    expect(result.rows).toEqual([{ dfecha: '2026-10-01', vnumero: 'A-0001' }]);
  });

  it('caps the rows returned and flags truncation', async () => {
    const big = await adapter.executeSql('a', 'SELECT g FROM generate_series(1, 50000) g', options);
    expect(big.rowCount).toBe(1_000);
    expect(big.rows).toHaveLength(1_000);
    expect(big.truncated).toBe(true);

    const exact = await adapter.executeSql('a', 'SELECT g FROM generate_series(1, 1000) g', options);
    expect(exact).toMatchObject({ rowCount: 1_000, truncated: false });
  });

  it('supports EXPLAIN', async () => {
    const result = await adapter.executeSql('a', 'EXPLAIN SELECT nfacturaventa FROM stock.factura_venta', options);
    expect(result.columns).toEqual(['QUERY PLAN']);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
  });

  it('rejects several statements, so COMMIT cannot leave the READ ONLY transaction', async () => {
    const error = (await adapter
      .executeSql('a', 'COMMIT; SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE; DELETE FROM stock.factura_venta', options)
      .catch((caught: unknown) => caught)) as AppError;
    expect(error).toBeInstanceOf(DatabaseQueryError);
    expect(error.diagnostics?.sqlState).toBe('42601');
    expect(await countFacturas()).toEqual({ n: 3 });
  });

  it.each([
    ['UPDATE', "UPDATE stock.factura_venta SET ftotal = 0"],
    ['DELETE', 'DELETE FROM stock.factura_venta'],
    ['write inside a SECURITY DEFINER function', 'SELECT util.write_side_effect()'],
    ['DDL', 'CREATE TABLE stock.y (id int)'],
  ])('cannot write: %s', async (_case, sql) => {
    const error = (await adapter.executeSql('a', sql, options).catch((caught: unknown) => caught)) as AppError;
    expect(['25006', '42501']).toContain(error.diagnostics?.sqlState);
    expect(await countFacturas()).toEqual({ n: 3 });
  });

  it('a session setting changed by one call is reverted before the next one', async () => {
    await adapter.executeSql('a', "SELECT set_config('default_transaction_read_only', 'off', false)", options);
    await adapter.executeSql('a', "SELECT set_config('statement_timeout', '0', false)", options);
    const after = await adapter.executeSql('a', 'SHOW default_transaction_read_only', options);
    expect(after.rows).toEqual([{ default_transaction_read_only: 'on' }]);
    await expect(adapter.executeSql('a', 'SELECT pg_sleep(2)', { ...options, timeoutMs: 200 })).rejects.toBeInstanceOf(
      QueryTimeoutError,
    );
  });

  it('enforces its own timeout and keeps the connection usable', async () => {
    const error = (await adapter
      .executeSql('a', 'SELECT pg_sleep(2)', { ...options, timeoutMs: 200 })
      .catch((caught: unknown) => caught)) as AppError;
    expect(error).toBeInstanceOf(QueryTimeoutError);
    expect(error.diagnostics?.sqlState).toBe('57014');
    expect((await adapter.executeSql('a', 'SELECT 1 AS ok', options)).rows).toEqual([{ ok: 1 }]);
  });

  it('returns PostgreSQL diagnostics for SQL errors', async () => {
    const syntax = (await adapter.executeSql('a', 'SELEC 1', options).catch((caught: unknown) => caught)) as AppError;
    expect(syntax).toBeInstanceOf(DatabaseQueryError);
    expect(syntax.diagnostics).toMatchObject({ sqlState: '42601', message: 'syntax error at or near "SELEC"', position: 1 });

    const denied = (await adapter
      .executeSql('a', 'SELECT vpassword FROM seguridad.usuario', options)
      .catch((caught: unknown) => caught)) as AppError;
    expect(denied).toBeInstanceOf(AuthorizationError);
    expect(denied.diagnostics?.sqlState).toBe('42501');
    expect(JSON.stringify(denied)).not.toContain('hash-should-never-leak');
  });

  it('reads the safe seguridad columns', async () => {
    const result = await adapter.executeSql('a', 'SELECT nusuario, vnombre FROM seguridad.usuario', options);
    expect(result.rows).toEqual([{ nusuario: 1, vnombre: 'Ada' }]);
  });
});
