import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Client as McpClient } from '@modelcontextprotocol/client';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseConfig } from '../../api/config.js';
import { createDatabase } from '../../api/db.js';
import type { AppError } from '../../api/errors.js';
import { callTool, connectClient, makeUser, startTestApp, type TestApp } from '../helpers.js';

/**
 * Real PostgreSQL (disposable container, needs Docker): two tenant databases with
 * different data, the MCP connecting as mcp_popey_ro with the production role script.
 */
const RO_PASSWORD = 'ro_test_password';
const TENANTS = ['tenant_a', 'tenant_b'] as const;
const ROLE_SCRIPT = fileURLToPath(new URL('../../scripts/create_readonly_role.sql', import.meta.url));

// Every schema the role script grants must exist.
const SCHEMA_SQL = `
  CREATE SCHEMA stock; CREATE SCHEMA compra; CREATE SCHEMA seguridad; CREATE SCHEMA administracion;
  CREATE SCHEMA e_plataforma; CREATE SCHEMA ecommerce; CREATE SCHEMA mercado_libre;
  CREATE SCHEMA servicio_tecnico; CREATE SCHEMA util; CREATE SCHEMA venta;
  CREATE TABLE stock.factura_venta (
    nfacturaventa int PRIMARY KEY, ncliente int, vnumero varchar, dfecha date, ndeposito int,
    ftotal numeric(12,2), ntipocomprobante int, nestadofactura int, nlistaprecio int, vafip_cae varchar,
    nrazonsocial int, ncarritoventa int, ftotaliibb numeric(12,2), nestadonc int, vsecreto varchar
  );
  CREATE TABLE compra.orden_compra (nordencompra int PRIMARY KEY, ftotal numeric(12,2));
  CREATE TABLE seguridad.usuario (nusuario int, vnombre varchar, vapellido varchar, vusuario varchar, vpassword varchar, vcodigo2fa varchar);
  INSERT INTO seguridad.usuario VALUES (1, 'Ada', 'Lovelace', 'admin', 'hash-should-never-leak', '123456');
  -- SECURITY DEFINER owned by the superuser: privileges would allow the write; only READ ONLY stops it.
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

const runRoleScript = (tenant: string) =>
  container.exec([
    'psql', '-U', container.getUsername(), '-d', tenant, '-v', 'ON_ERROR_STOP=1',
    '-v', `ro_password=${RO_PASSWORD}`, '-v', `owner_role=${container.getUsername()}`,
    '-f', '/tmp/create_readonly_role.sql',
  ]);

async function runAsSuperuser(database: string, sql: string): Promise<void> {
  const client = new pg.Client(superConfig(database));
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** A database layer over the given tenants (one connection: leaked session state would show). */
const databaseOver = (databases: Record<string, DatabaseConfig>, timeoutMs = 1_000) =>
  createDatabase({ databases: new Map(Object.entries(databases)), poolMax: 1, maxRows: 1_000, timeoutMs });

const errorOf = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error as AppError);

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
    const result = await runRoleScript(tenant);
    if (result.exitCode !== 0) throw new Error(`create_readonly_role.sql failed:\n${result.output}`);
  }
});

afterAll(async () => {
  await container?.stop();
});

describe('multi-tenant through the MCP (HTTP, real PostgreSQL)', () => {
  const userA = makeUser('user-a', 'ventas', 'tenant_a');
  const userB = makeUser('user-b', 'ventas', 'tenant_b');
  let database: ReturnType<typeof createDatabase>;
  let app: TestApp;
  let clientA: McpClient;
  let clientB: McpClient;
  const facturas = { sql: 'SELECT nfacturaventa, vnumero, dfecha, ftotal FROM stock.factura_venta ORDER BY nfacturaventa' };

  beforeAll(async () => {
    database = databaseOver({ tenant_a: roConfig('tenant_a'), tenant_b: roConfig('tenant_b') });
    app = await startTestApp([userA, userB], { runSql: database.runSql });
    clientA = await connectClient(app.url, userA.token);
    clientB = await connectClient(app.url, userB.token);
  });

  afterAll(async () => {
    await Promise.all([clientA?.close(), clientB?.close()]);
    await app?.close();
    await database?.close();
  });

  it('UserA sees only database A, UserB only database B', async () => {
    const a = await callTool(clientA, 'query_sql', facturas);
    const b = await callTool(clientB, 'query_sql', facturas);
    expect(a.data.rows.map((row: { vnumero: string }) => row.vnumero)).toEqual(['A-0001', 'A-0002', 'A-0003']);
    expect(b.data.rows.map((row: { vnumero: string }) => row.vnumero)).toEqual(['B-0001']);
  });

  it('a manual databaseKey cannot redirect UserA to B', async () => {
    const outcome = await callTool(clientA, 'query_sql', { ...facturas, databaseKey: 'tenant_b' });
    expect(outcome.isError).toBe(true);
    expect(JSON.stringify(outcome.data)).not.toContain('B-0001');
  });

  it('DATE comes back as YYYY-MM-DD (no timezone shift)', async () => {
    const a = await callTool(clientA, 'query_sql', { sql: 'SELECT dfecha FROM stock.factura_venta WHERE nfacturaventa = 1' });
    expect(a.data.rows[0].dfecha).toBe('2026-10-01');
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

  it('reads the safe seguridad.usuario columns, never the sensitive ones nor SELECT *', async () => {
    expect(await asReadOnly('SELECT nusuario, vnombre, vapellido, vusuario FROM seguridad.usuario')).toBeUndefined();
    expect(await asReadOnly('SELECT vpassword FROM seguridad.usuario')).toBe('42501');
    expect(await asReadOnly('SELECT vcodigo2fa FROM seguridad.usuario')).toBe('42501');
    expect(await asReadOnly('SELECT * FROM seguridad.usuario')).toBe('42501');
    expect(await asReadOnly("SELECT nusuario FROM seguridad.usuario WHERE vpassword = 'x'")).toBe('42501');
  });

  it('the role script is idempotent and keeps the column grants', async () => {
    for (let run = 0; run < 2; run++) expect((await runRoleScript('tenant_a')).exitCode).toBe(0);
    expect(await asReadOnly('SELECT nusuario, vnombre FROM seguridad.usuario')).toBeUndefined();
    expect(await asReadOnly('SELECT vpassword FROM seguridad.usuario')).toBe('42501');
  });

  it.each([
    ['INSERT', 'INSERT INTO stock.factura_venta (nfacturaventa) VALUES (999)'],
    ['UPDATE', 'UPDATE stock.factura_venta SET ftotal = 0'],
    ['DELETE', 'DELETE FROM stock.factura_venta'],
    ['TRUNCATE', 'TRUNCATE stock.factura_venta'],
    ['CREATE', 'CREATE TABLE stock.x (id int)'],
    ['DROP', 'DROP TABLE stock.factura_venta'],
    ['write seguridad', 'INSERT INTO seguridad.usuario (nusuario) VALUES (2)'],
  ])('cannot %s', async (_case, sql) => {
    expect(['25006', '42501']).toContain(await asReadOnly(sql));
  });
});

describe('db.ts barriers', () => {
  let database: ReturnType<typeof createDatabase>;
  const count = async () => (await database.runSql('a', 'SELECT count(*)::int AS n FROM stock.factura_venta')).rows[0];

  beforeAll(() => {
    database = databaseOver({ a: roConfig('tenant_a') });
  });

  afterAll(async () => {
    await database?.close();
  });

  it('runs inside READ ONLY transactions even with a superuser', async () => {
    const owner = databaseOver({ owner: superConfig('tenant_a') });
    try {
      expect((await errorOf(owner.runSql('owner', 'INSERT INTO stock.factura_venta (nfacturaventa) VALUES (999)')))?.diagnostics?.sqlState).toBe('25006');
      expect((await owner.runSql('owner', 'SELECT count(*)::int AS n FROM stock.factura_venta')).rows[0]).toEqual({ n: 3 });
    } finally {
      await owner.close();
    }
  });

  it('runs free SQL: CTEs and aggregates, columns in statement order', async () => {
    const result = await database.runSql(
      'a',
      'WITH f AS (SELECT ncliente, ftotal FROM stock.factura_venta) SELECT count(*)::int AS facturas, sum(ftotal) AS total FROM f WHERE ftotal > 10',
    );
    expect(result).toEqual({ columns: ['facturas', 'total'], rows: [{ facturas: 3, total: '3050.00' }], rowCount: 1, truncated: false });
  });

  it('caps the rows returned and flags truncation', async () => {
    expect(await database.runSql('a', 'SELECT g FROM generate_series(1, 50000) g')).toMatchObject({ rowCount: 1_000, truncated: true });
    expect(await database.runSql('a', 'SELECT g FROM generate_series(1, 1000) g')).toMatchObject({ rowCount: 1_000, truncated: false });
  });

  it('supports EXPLAIN', async () => {
    expect((await database.runSql('a', 'EXPLAIN SELECT nfacturaventa FROM stock.factura_venta')).columns).toEqual(['QUERY PLAN']);
  });

  it('rejects several statements, so COMMIT cannot leave the READ ONLY transaction', async () => {
    const error = await errorOf(
      database.runSql('a', 'COMMIT; SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE; DELETE FROM stock.factura_venta'),
    );
    expect(error?.diagnostics?.sqlState).toBe('42601');
    expect(await count()).toEqual({ n: 3 });
  });

  it.each([
    ['UPDATE', 'UPDATE stock.factura_venta SET ftotal = 0'],
    ['DELETE', 'DELETE FROM stock.factura_venta'],
    ['write inside a SECURITY DEFINER function', 'SELECT util.write_side_effect()'],
    ['DDL', 'CREATE TABLE stock.y (id int)'],
  ])('cannot write: %s', async (_case, sql) => {
    expect(['25006', '42501']).toContain((await errorOf(database.runSql('a', sql)))?.diagnostics?.sqlState);
    expect(await count()).toEqual({ n: 3 });
  });

  it('a session setting changed by one call is reverted before the next one', async () => {
    await database.runSql('a', "SELECT set_config('default_transaction_read_only', 'off', false)");
    await database.runSql('a', "SELECT set_config('statement_timeout', '0', false)");
    expect((await database.runSql('a', 'SHOW default_transaction_read_only')).rows).toEqual([{ default_transaction_read_only: 'on' }]);
    expect((await errorOf(database.runSql('a', 'SELECT pg_sleep(2)')))?.code).toBe('QUERY_TIMEOUT');
  });

  it('enforces the timeout and keeps the connection usable', async () => {
    const error = await errorOf(database.runSql('a', 'SELECT pg_sleep(2)'));
    expect(error?.code).toBe('QUERY_TIMEOUT');
    expect(error?.diagnostics?.sqlState).toBe('57014');
    expect((await database.runSql('a', 'SELECT 1 AS ok')).rows).toEqual([{ ok: 1 }]);
  });

  it('returns PostgreSQL diagnostics, never the denied data', async () => {
    expect((await errorOf(database.runSql('a', 'SELEC 1')))?.diagnostics).toMatchObject({ sqlState: '42601', position: 1 });
    const denied = await errorOf(database.runSql('a', 'SELECT vpassword FROM seguridad.usuario'));
    expect(denied?.code).toBe('AUTHORIZATION_ERROR');
    expect(JSON.stringify(denied)).not.toContain('hash-should-never-leak');
  });

  it('reuses one pool per databaseKey', async () => {
    const two = createDatabase({ databases: new Map([['a', roConfig('tenant_a')], ['b', roConfig('tenant_b')]]), poolMax: 2, maxRows: 10, timeoutMs: 1_000 });
    try {
      expect(two.poolFor('a')).toBe(two.poolFor('a'));
      expect(two.poolFor('a')).not.toBe(two.poolFor('b'));
      await Promise.all(Array.from({ length: 10 }, () => two.runSql('a', 'SELECT 1')));
      expect(two.poolFor('a').totalCount).toBeLessThanOrEqual(2);
    } finally {
      await two.close();
    }
  });
});
