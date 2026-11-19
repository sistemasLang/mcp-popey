import { generateKeyPairSync } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseQueryError } from '../../api/domain/errors.js';
import {
  callTool,
  connectClient,
  makeAdmin,
  makeUser,
  mcpToken,
  signJwt,
  SpyDatabaseAdapter,
  startTestApp,
  TEST_ISSUER,
  TEST_MCP_AUDIENCE,
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
const adminWithoutRole = makeAdmin('admin-1');
const n8n = makeUser('n8n', 'ventas', 'tenant_a', true, 'service');

const spy = new SpyDatabaseAdapter((databaseKey) => ({ rows: [{ tenant: databaseKey }], rowCount: 1 }));
let testApp: TestApp;
let clientA: Client;
let clientB: Client;
let clientC: Client;

const facturas = { sql: 'SELECT nfacturaventa, ftotal FROM stock.factura_venta' };

beforeAll(async () => {
  testApp = await startTestApp([userA, userB, comprador, disabled, adminWithoutRole, n8n], { database: spy });
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
  const post = (authorization?: string) =>
    fetch(testApp.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify(initialize),
    });
  const now = () => Math.floor(Date.now() / 1000);
  const foreignKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

  it.each([
    ['no token', undefined],
    ['static token of the old scheme', `Bearer ${'A'.repeat(43)}`],
    ['signature from a key outside the JWKS', `Bearer ${signJwt({ sub: userA.subject, aud: TEST_MCP_AUDIENCE }, { key: foreignKey })}`],
    ['alg none', `Bearer ${signJwt({ sub: userA.subject, aud: TEST_MCP_AUDIENCE }, { alg: 'none' })}`],
    ['alg HS256', `Bearer ${signJwt({ sub: userA.subject, aud: TEST_MCP_AUDIENCE }, { alg: 'HS256' })}`],
    ['expired more than 30 s ago', `Bearer ${mcpToken(userA.subject, { exp: now() - 60 })}`],
    ['issuer of another tenant', `Bearer ${mcpToken(userA.subject, { iss: 'https://other-tenant.test/' })}`],
    ['admin panel token (aud admin)', `Bearer ${userA.adminToken}`],
  ])('%s → 401 with resource_metadata, before any MCP processing', async (_case, authorization) => {
    const response = await post(authorization);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('valid token but no access → 403 with the same body for every reason', async () => {
    const reasons = [mcpToken('auth0|not-provisioned'), disabled.token, adminWithoutRole.token];
    const bodies: string[] = [];
    for (const token of reasons) {
      const response = await post(`Bearer ${token}`);
      expect(response.status).toBe(403);
      bodies.push(await response.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain('Forbidden');
  });

  it('disabling a user cuts a still-valid token on the next request', async () => {
    const temp = makeUser('user-temp', 'ventas', 'tenant_a');
    await testApp.users.save(temp.user);
    expect((await post(`Bearer ${temp.token}`)).status).toBe(200);
    await testApp.users.save({ ...temp.user, enabled: false });
    expect((await post(`Bearer ${temp.token}`)).status).toBe(403);
  });

  it('identity comes only from (iss, sub): injected role and databaseKey claims are ignored', async () => {
    const client = await connectClient(testApp.url, mcpToken(userA.subject, { role: 'analista', databaseKey: 'tenant_b' }));
    try {
      spy.calls.length = 0;
      testApp.audit.events.length = 0;
      await callTool(client, 'query_sql', facturas);
      expect(spy.calls[0]?.databaseKey).toBe('tenant_a');
      expect(testApp.audit.events[0]).toMatchObject({ role: 'ventas', databaseKey: 'tenant_a' });
    } finally {
      await client.close();
    }
  });

  it('a service account (client_credentials, sub <client_id>@clients) works like a person and is audited as such', async () => {
    const client = await connectClient(testApp.url, n8n.token);
    try {
      testApp.audit.events.length = 0;
      expect((await callTool(client, 'list_circuits')).isError).toBe(false);
      expect(testApp.audit.events[0]).toMatchObject({ userId: 'n8n', principalKind: 'service', role: 'ventas' });
    } finally {
      await client.close();
    }
  });

  it.each(['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'])(
    'GET %s → protected resource metadata, without auth',
    async (path) => {
      const response = await fetch(new URL(path, testApp.url));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        resource: TEST_MCP_AUDIENCE,
        authorization_servers: [TEST_ISSUER],
        bearer_methods_supported: ['header'],
      });
    },
  );

  it('POST to the metadata → 405', async () => {
    const response = await fetch(new URL('/.well-known/oauth-protected-resource/mcp', testApp.url), { method: 'POST' });
    expect(response.status).toBe(405);
  });

  it('other paths → 404', async () => {
    for (const path of ['/admin', '/data/users.yaml', '/.well-known/openid-configuration']) {
      expect((await fetch(new URL(path, testApp.url))).status).toBe(404);
    }
  });
});

describe('milestone 1: list_circuits → describe_circuit', () => {
  it('exposes exactly three read-only tools; only query_sql takes SQL, none takes a database', async () => {
    const { tools } = await clientA.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['describe_circuit', 'list_circuits', 'query_sql']);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      const properties = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {});
      if (tool.name !== 'query_sql') expect(properties).not.toContain('sql');
      for (const forbidden of ['rawQuery', 'databaseKey', 'database', 'host', 'schema', 'params']) {
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

  it('describe_circuit lists seguridad columns without the sensitive ones', async () => {
    const { data } = await callTool(clientA, 'describe_circuit', { circuit: 'usuario' });
    for (const table of data.tables) {
      expect(table.columns).not.toEqual(expect.arrayContaining(['vpassword']));
      expect(table.columns).not.toEqual(expect.arrayContaining(['vcodigo2fa']));
    }
  });
});

describe('tenant isolation (database chosen by UserContext only)', () => {
  it('each user reaches only its own databaseKey', async () => {
    spy.calls.length = 0;
    const a = await callTool(clientA, 'query_sql', facturas);
    const b = await callTool(clientB, 'query_sql', facturas);
    expect(a.data.rows).toEqual([{ tenant: 'tenant_a' }]);
    expect(b.data.rows).toEqual([{ tenant: 'tenant_b' }]);
    expect(spy.calls.map((call) => call.databaseKey)).toEqual(['tenant_a', 'tenant_b']);
  });

  it.each(['databaseKey', 'database', 'host', 'schema', 'params'])(
    'sending "%s" in the arguments is rejected and nothing is executed',
    async (property) => {
      spy.calls.length = 0;
      const outcome = await callTool(clientA, 'query_sql', { ...facturas, [property]: 'tenant_b' });
      expect(outcome.isError).toBe(true);
      expect(JSON.stringify(outcome.data)).toContain(`Unrecognized key: \\"${property}\\"`);
      expect(spy.calls).toHaveLength(0);
    },
  );
});

describe('controlled errors and audit', () => {
  it('internal errors are generic: no SQL, no connection string, no stack', async () => {
    const leaky = new SpyDatabaseAdapter(
      () => new Error('connect ECONNREFUSED postgres://mcp_popey_ro:s3cret@10.0.0.5:5432/lang SELECT "x" FROM y'),
    );
    const isolated = await startTestApp([userA], { database: leaky });
    const client = await connectClient(isolated.url, userA.token);
    try {
      const outcome = await callTool(client, 'query_sql', facturas);
      expect(outcome.isError).toBe(true);
      expect(outcome.data.error).toEqual({ code: 'INTERNAL_ERROR', message: 'An internal error occurred' });
      expect(JSON.stringify(outcome.data)).not.toMatch(/s3cret|postgres:\/\/|SELECT|at \w+ \(/);
    } finally {
      await client.close();
      await isolated.close();
    }
  });

  it('audits successes and failures without token', async () => {
    testApp.audit.events.length = 0;
    await callTool(clientA, 'describe_circuit', { circuit: 'venta' });
    await callTool(clientA, 'describe_circuit', { circuit: 'compras' });

    const [ok, denied] = testApp.audit.events;
    expect(ok).toMatchObject({
      userId: 'user-a',
      principalKind: 'human',
      role: 'ventas',
      databaseKey: 'tenant_a',
      tool: 'describe_circuit',
      circuit: 'venta',
      success: true,
    });
    expect(typeof ok?.durationMs).toBe('number');
    expect(denied).toMatchObject({ circuit: 'compras', success: false, errorCode: 'AUTHORIZATION_ERROR' });
    expect(JSON.stringify(testApp.audit.events)).not.toContain(userA.token);
  });

  it('rate limit is per user', async () => {
    const limited = await startTestApp([userA, userB], {
      database: new SpyDatabaseAdapter(),
      rateLimit: { maxRequests: 2, windowMs: 60_000 },
    });
    const a = await connectClient(limited.url, userA.token);
    const b = await connectClient(limited.url, userB.token);
    try {
      expect((await callTool(a, 'query_sql', facturas)).isError).toBe(false);
      expect((await callTool(a, 'query_sql', facturas)).isError).toBe(false);
      const third = await callTool(a, 'query_sql', facturas);
      expect(third.data.error.code).toBe('RATE_LIMIT_EXCEEDED');
      // Another user is unaffected.
      expect((await callTool(b, 'query_sql', facturas)).isError).toBe(false);
    } finally {
      await Promise.all([a.close(), b.close()]);
      await limited.close();
    }
  });
});

describe('query_sql (free read-only SQL, every role)', () => {
  const analista = makeUser('user-s', 'analista', 'tenant_a');
  const sqlSpy = new SpyDatabaseAdapter((databaseKey) => ({ rows: [{ tenant: databaseKey, n: 3 }], rowCount: 1 }));
  let sqlApp: TestApp;
  let clientS: Client;
  let clientV: Client;

  beforeAll(async () => {
    sqlApp = await startTestApp([analista, userA], { database: sqlSpy });
    clientS = await connectClient(sqlApp.url, analista.token);
    clientV = await connectClient(sqlApp.url, userA.token);
  });

  afterAll(async () => {
    await Promise.all([clientS?.close(), clientV?.close()]);
    await sqlApp?.close();
  });

  it('is listed for every role, as read-only, with sql as its only input', async () => {
    for (const client of [clientS, clientV]) {
      const tool = (await client.listTools()).tools.find((candidate) => candidate.name === 'query_sql');
      expect(tool?.annotations?.readOnlyHint).toBe(true);
      expect(Object.keys((tool?.inputSchema as { properties?: object }).properties ?? {})).toEqual(['sql']);
      expect(tool?.description).toContain('At most 1000 rows');
    }
  });

  it('a role whose circuits do not cover a table can still query it', async () => {
    sqlSpy.calls.length = 0;
    const outcome = await callTool(clientV, 'query_sql', { sql: 'SELECT nordencompra FROM compra.orden_compra' });
    expect(outcome.isError).toBe(false);
    expect(sqlSpy.calls).toHaveLength(1);
  });

  it('runs the SQL untouched on the database of the UserContext', async () => {
    sqlSpy.calls.length = 0;
    sqlSpy.sqlOptions.length = 0;
    const sql = 'SELECT count(*) AS n FROM stock.factura_venta f JOIN venta.cliente c USING (ncliente) GROUP BY c.ncliente';
    const outcome = await callTool(clientS, 'query_sql', { sql });
    expect(outcome.isError).toBe(false);
    expect(outcome.data).toEqual({ columns: ['tenant', 'n'], rows: [{ tenant: 'tenant_a', n: 3 }], rowCount: 1, truncated: false });
    expect(sqlSpy.calls).toEqual([{ databaseKey: 'tenant_a', sql }]);
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
    const isolated = await startTestApp([analista], { database: failing });
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

  it('consumes rate limit quota; the catalog tools do not', async () => {
    const limited = await startTestApp([analista], {
      database: new SpyDatabaseAdapter(),
      rateLimit: { maxRequests: 1, windowMs: 60_000 },
    });
    const client = await connectClient(limited.url, analista.token);
    try {
      expect((await callTool(client, 'query_sql', { sql: 'SELECT 1' })).isError).toBe(false);
      expect((await callTool(client, 'query_sql', { sql: 'SELECT 1' })).data.error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect((await callTool(client, 'list_circuits')).isError).toBe(false);
      expect((await callTool(client, 'describe_circuit', { circuit: 'venta' })).isError).toBe(false);
    } finally {
      await client.close();
      await limited.close();
    }
  });
});
