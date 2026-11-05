import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseQueryError } from '../../src/errors/app-errors.js';
import {
  callTool,
  connectClient,
  makeUser,
  SpyDatabaseAdapter,
  startTestApp,
  type TestApp,
} from '../e2e-harness.js';

/**
 * End-to-end over real HTTP with the official MCP client. The database is a
 * spy, so these tests prove what does — and does not — reach it.
 */
const userA = makeUser('user-a', 'ventas', 'tenant_a');
const userB = makeUser('user-b', 'ventas', 'tenant_b');
const comprador = makeUser('user-c', 'compras', 'tenant_a');
const disabled = makeUser('user-d', 'ventas', 'tenant_a', false);

const spy = new SpyDatabaseAdapter((databaseKey) => ({ rows: [{ tenant: databaseKey }], rowCount: 1 }));
let testApp: TestApp;
let clientA: Client;
let clientB: Client;
let clientC: Client;

const facturas = { circuit: 'venta', table: 'stock.factura_venta', select: ['nfacturaventa', 'ftotal'] };

beforeAll(async () => {
  testApp = await startTestApp([userA, userB, comprador, disabled], { databaseAdapter: spy });
  clientA = await connectClient(testApp.url, userA.token);
  clientB = await connectClient(testApp.url, userB.token);
  clientC = await connectClient(testApp.url, comprador.token);
});

afterAll(async () => {
  await Promise.all([clientA?.close(), clientB?.close(), clientC?.close()]);
  await testApp?.close();
});

describe('authentication (HTTP)', () => {
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
  };

  it.each([
    ['no token', undefined],
    ['invalid token', 'Bearer not-a-real-token-but-long-enough-to-pass-format-x'],
    ['disabled user', `Bearer ${disabled.token}`],
  ])('%s → 401 before any MCP processing', async (_case, authorization) => {
    const response = await fetch(testApp.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify(initialize),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toMatch(/^Bearer/);
  });

  it('other paths → 404', async () => {
    const response = await fetch(new URL('/admin', testApp.url));
    expect(response.status).toBe(404);
  });
});

describe('milestone 1: list_circuits → describe_circuit', () => {
  it('a role without sql: true sees exactly three tools, none of them raw SQL', async () => {
    const { tools } = await clientA.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['describe_circuit', 'list_circuits', 'query_circuit']);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      const properties = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {});
      expect(properties).not.toEqual(expect.arrayContaining(['sql']));
      for (const forbidden of ['sql', 'rawQuery', 'query', 'databaseKey', 'database', 'host', 'schema']) {
        expect(properties).not.toContain(forbidden);
      }
    }
  });

  it('list_circuits returns only the circuits of the role', async () => {
    const a = await callTool(clientA, 'list_circuits');
    expect(a.isError).toBe(false);
    expect(a.data.circuits.map((circuit: { id: string }) => circuit.id)).toEqual(['venta', 'envio_comprobantes', 'usuario']);

    const c = await callTool(clientC, 'list_circuits');
    expect(c.data.circuits.map((circuit: { id: string }) => circuit.id)).toEqual(['compras']);
  });

  it('describe_circuit returns tables, queryability and columns', async () => {
    const { isError, data } = await callTool(clientA, 'describe_circuit', { circuit: 'venta' });
    expect(isError).toBe(false);
    const factura = data.tables.find((table: { table: string }) => table.table === 'stock.factura_venta');
    expect(factura).toMatchObject({ queryable: true });
    expect(factura.columns).toEqual(expect.arrayContaining(['nfacturaventa', 'ncliente', 'vnumero', 'dfecha', 'ftotal']));
  });

  it('describe_circuit of a circuit outside the role → AUTHORIZATION_ERROR', async () => {
    const { isError, data } = await callTool(clientA, 'describe_circuit', { circuit: 'compras' });
    expect(isError).toBe(true);
    expect(data.error.code).toBe('AUTHORIZATION_ERROR');
  });
});

describe('tenant isolation (database chosen by UserContext only)', () => {
  it('each user reaches only its own databaseKey', async () => {
    spy.calls.length = 0;
    const a = await callTool(clientA, 'query_circuit', facturas);
    const b = await callTool(clientB, 'query_circuit', facturas);
    expect(a.data.rows).toEqual([{ tenant: 'tenant_a' }]);
    expect(b.data.rows).toEqual([{ tenant: 'tenant_b' }]);
    expect(spy.calls.map((call) => call.databaseKey)).toEqual(['tenant_a', 'tenant_b']);
  });

  it.each(['databaseKey', 'database', 'host', 'sql', 'schema'])(
    'sending "%s" in the arguments is rejected and nothing is executed',
    async (property) => {
      spy.calls.length = 0;
      const outcome = await callTool(clientA, 'query_circuit', { ...facturas, [property]: 'tenant_b' });
      expect(outcome.isError).toBe(true);
      expect(JSON.stringify(outcome.data)).toContain(`Unrecognized key: \\"${property}\\"`);
      expect(spy.calls).toHaveLength(0);
    },
  );
});

describe('seguridad schema: only through the usuario circuit, never its sensitive columns', () => {
  it.each([
    ['seguridad.usuario', ['nusuario', 'vnombre', 'vapellido']],
    ['seguridad.usuarioxrol', ['nusuario', 'nrol']],
    ['seguridad.rol', ['nrol', 'vrol']],
    ['seguridad.view_usuario', ['nusuario', 'vfullname']],
  ])('usuario circuit, %s reaches the database', async (table, select) => {
    spy.calls.length = 0;
    const outcome = await callTool(clientA, 'query_circuit', { circuit: 'usuario', table, select });
    expect(outcome.isError).toBe(false);
    expect(spy.calls).toHaveLength(1);
  });

  const attempts: Array<[string, Record<string, unknown>]> = [
    ['usuario circuit, vpassword', { circuit: 'usuario', table: 'seguridad.usuario', select: ['vpassword'] }],
    ['usuario circuit, 2FA code', { circuit: 'usuario', table: 'seguridad.usuario', select: ['nusuario', 'vcodigo2fa'] }],
    ['usuario circuit, view vpassword', { circuit: 'usuario', table: 'seguridad.view_usuario', select: ['vpassword'] }],
    [
      'usuario circuit, filter on vpassword',
      { circuit: 'usuario', table: 'seguridad.usuario', select: ['nusuario'], filters: [{ field: 'vpassword', operator: 'isNotNull' }] },
    ],
    ['other circuit, seguridad table', { circuit: 'venta', table: 'seguridad.usuario', select: ['nusuario'] }],
    ['seguridad as column', { ...facturas, select: ['seguridad.usuario.vpassword'] }],
    ['seguridad in filter field', { ...facturas, filters: [{ field: 'seguridad.usuario.vpassword', operator: 'isNotNull' }] }],
    ['seguridad in order field', { ...facturas, orderBy: [{ field: '(SELECT vpassword FROM seguridad.usuario)', direction: 'asc' }] }],
    ['subquery as value stays a value', { ...facturas, filters: [{ field: 'vnumero', operator: 'eq', value: 'x' }], schema: 'seguridad' }],
  ];

  it.each(attempts)('%s', async (_case, args) => {
    spy.calls.length = 0;
    const outcome = await callTool(clientA, 'query_circuit', args);
    expect(outcome.isError).toBe(true);
    expect(spy.calls).toHaveLength(0);
  });

  it('describe_circuit lists seguridad columns without the sensitive ones', async () => {
    const { data } = await callTool(clientA, 'describe_circuit', { circuit: 'usuario' });
    for (const table of data.tables) {
      expect(table.queryable).toBe(true);
      expect(table.columns).not.toEqual(expect.arrayContaining(['vpassword']));
      expect(table.columns).not.toEqual(expect.arrayContaining(['vcodigo2fa']));
    }
  });
});

describe('controlled errors and audit', () => {
  it('internal errors are generic: no SQL, no connection string, no stack', async () => {
    const leaky = new SpyDatabaseAdapter(
      () => new Error('connect ECONNREFUSED postgres://mcp_popey_ro:s3cret@10.0.0.5:5432/lang SELECT "x" FROM y'),
    );
    const isolated = await startTestApp([userA], { databaseAdapter: leaky });
    const client = await connectClient(isolated.url, userA.token);
    try {
      const outcome = await callTool(client, 'query_circuit', facturas);
      expect(outcome.isError).toBe(true);
      expect(outcome.data.error).toEqual({ code: 'INTERNAL_ERROR', message: 'An internal error occurred' });
      expect(JSON.stringify(outcome.data)).not.toMatch(/s3cret|postgres:\/\/|SELECT|at \w+ \(/);
    } finally {
      await client.close();
      await isolated.close();
    }
  });

  it('audits every query without token, values or rows', async () => {
    testApp.audit.events.length = 0;
    await callTool(clientA, 'query_circuit', {
      ...facturas,
      filters: [{ field: 'vnumero', operator: 'eq', value: 'VALOR-SECRETO' }],
    });
    await callTool(clientA, 'query_circuit', { ...facturas, table: 'seguridad.usuario' });

    const [ok, denied] = testApp.audit.events;
    expect(ok).toMatchObject({
      userId: 'user-a',
      role: 'ventas',
      databaseKey: 'tenant_a',
      tool: 'query_circuit',
      circuit: 'venta',
      table: 'stock.factura_venta',
      columns: ['nfacturaventa', 'ftotal'],
      filterFields: ['vnumero'],
      rowCount: 1,
      success: true,
    });
    expect(typeof ok?.durationMs).toBe('number');
    expect(denied).toMatchObject({ success: false, errorCode: 'TABLE_NOT_ALLOWED' });

    const serialized = JSON.stringify(testApp.audit.events);
    expect(serialized).not.toContain(userA.token);
    expect(serialized).not.toContain('VALOR-SECRETO');
    expect(serialized).not.toContain('"rows"');
  });

  it('rate limit is per user', async () => {
    const limited = await startTestApp([userA, userB], {
      databaseAdapter: new SpyDatabaseAdapter(),
      rateLimit: { maxRequests: 2, windowMs: 60_000 },
    });
    const a = await connectClient(limited.url, userA.token);
    const b = await connectClient(limited.url, userB.token);
    try {
      expect((await callTool(a, 'query_circuit', facturas)).isError).toBe(false);
      expect((await callTool(a, 'query_circuit', facturas)).isError).toBe(false);
      const third = await callTool(a, 'query_circuit', facturas);
      expect(third.data.error.code).toBe('RATE_LIMIT_EXCEEDED');
      // Another user is unaffected.
      expect((await callTool(b, 'query_circuit', facturas)).isError).toBe(false);
    } finally {
      await Promise.all([a.close(), b.close()]);
      await limited.close();
    }
  });
});

describe('query_sql (free read-only SQL, opt-in per role)', () => {
  const analista = makeUser('user-s', 'analista', 'tenant_a');
  const sqlSpy = new SpyDatabaseAdapter((databaseKey) => ({ rows: [{ tenant: databaseKey, n: 3 }], rowCount: 1 }));
  let sqlApp: TestApp;
  let clientS: Client;
  let clientV: Client;

  beforeAll(async () => {
    sqlApp = await startTestApp([analista, userA], { databaseAdapter: sqlSpy });
    clientS = await connectClient(sqlApp.url, analista.token);
    clientV = await connectClient(sqlApp.url, userA.token);
  });

  afterAll(async () => {
    await Promise.all([clientS?.close(), clientV?.close()]);
    await sqlApp?.close();
  });

  it('is listed only for roles with sql: true, as read-only', async () => {
    const withSql = (await clientS.listTools()).tools;
    const tool = withSql.find((candidate) => candidate.name === 'query_sql');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(Object.keys((tool?.inputSchema as { properties?: object }).properties ?? {})).toEqual(['sql']);
    expect(tool?.description).toContain('At most 1000 rows');

    const withoutSql = (await clientV.listTools()).tools.map((candidate) => candidate.name);
    expect(withoutSql).not.toContain('query_sql');
  });

  it('a role without sql: true cannot call it', async () => {
    sqlSpy.calls.length = 0;
    const outcome = await callTool(clientV, 'query_sql', { sql: 'SELECT 1' });
    expect(outcome.isError).toBe(true);
    expect(sqlSpy.calls).toHaveLength(0);
  });

  it('runs the SQL untouched on the database of the UserContext', async () => {
    sqlSpy.calls.length = 0;
    sqlSpy.sqlOptions.length = 0;
    const sql = 'SELECT count(*) AS n FROM stock.factura_venta f JOIN venta.cliente c USING (ncliente) GROUP BY c.ncliente';
    const outcome = await callTool(clientS, 'query_sql', { sql });
    expect(outcome.isError).toBe(false);
    expect(outcome.data).toEqual({ columns: ['tenant', 'n'], rows: [{ tenant: 'tenant_a', n: 3 }], rowCount: 1, truncated: false });
    expect(sqlSpy.calls).toEqual([{ databaseKey: 'tenant_a', sql, params: [] }]);
    expect(sqlSpy.sqlOptions).toEqual([{ timeoutMs: 30_000, maxRows: 1_000 }]);
  });

  it.each([
    ['databaseKey', { sql: 'SELECT 1', databaseKey: 'tenant_b' }],
    ['params', { sql: 'SELECT $1', params: [1] }],
    ['empty sql', { sql: '' }],
    ['missing sql', {}],
  ])('rejects %s before reaching the database', async (_case, args) => {
    sqlSpy.calls.length = 0;
    const outcome = await callTool(clientS, 'query_sql', args);
    expect(outcome.isError).toBe(true);
    expect(sqlSpy.calls).toHaveLength(0);
  });

  it('returns PostgreSQL diagnostics on SQL errors', async () => {
    const failing = new SpyDatabaseAdapter(
      () =>
        new DatabaseQueryError('The database could not execute the query', {
          diagnostics: { sqlState: '42601', message: 'syntax error at or near "SELEC"', position: 1 },
        }),
    );
    const isolated = await startTestApp([analista], { databaseAdapter: failing });
    const client = await connectClient(isolated.url, analista.token);
    try {
      const outcome = await callTool(client, 'query_sql', { sql: 'SELEC 1' });
      expect(outcome.isError).toBe(true);
      expect(outcome.data.error).toEqual({
        code: 'DATABASE_QUERY_ERROR',
        message: 'The database could not execute the query',
        diagnostics: { sqlState: '42601', message: 'syntax error at or near "SELEC"', position: 1 },
      });
    } finally {
      await client.close();
      await isolated.close();
    }
  });

  it('audits hash, length, rows and truncation, never the SQL text', async () => {
    sqlApp.audit.events.length = 0;
    const sql = "SELECT ncliente FROM venta.cliente WHERE vcuit = '20-12345678-9'";
    await callTool(clientS, 'query_sql', { sql });

    const [event] = sqlApp.audit.events;
    expect(event).toMatchObject({
      userId: 'user-s',
      role: 'analista',
      databaseKey: 'tenant_a',
      tool: 'query_sql',
      sqlSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      sqlLength: sql.length,
      rowCount: 1,
      truncated: false,
      success: true,
    });
    const serialized = JSON.stringify(sqlApp.audit.events);
    expect(serialized).not.toContain('20-12345678-9');
    expect(serialized).not.toContain('venta.cliente');
    expect(serialized).not.toContain(analista.token);
  });

  it('shares the rate limit quota with query_circuit', async () => {
    const limited = await startTestApp([analista], {
      databaseAdapter: new SpyDatabaseAdapter(),
      rateLimit: { maxRequests: 2, windowMs: 60_000 },
    });
    const client = await connectClient(limited.url, analista.token);
    try {
      expect((await callTool(client, 'query_circuit', facturas)).isError).toBe(false);
      expect((await callTool(client, 'query_sql', { sql: 'SELECT 1' })).isError).toBe(false);
      expect((await callTool(client, 'query_sql', { sql: 'SELECT 1' })).data.error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect((await callTool(client, 'query_circuit', facturas)).data.error.code).toBe('RATE_LIMIT_EXCEEDED');
    } finally {
      await client.close();
      await limited.close();
    }
  });
});
