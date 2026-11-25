import { generateKeyPairSync } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../api/errors.js';
import { createRateLimiter } from '../../api/tools/query-sql.js';
import {
  callTool,
  connectClient,
  makeUser,
  RESOURCE,
  ISSUER,
  signJwt,
  spyDatabase,
  startTestApp,
  type TestApp,
} from '../helpers.js';

/** End-to-end over real HTTP with the official MCP client; the database is a spy. */
const userA = makeUser('user-a', 'ventas', 'tenant_a');
const userB = makeUser('user-b', 'ventas', 'tenant_b');
const comprador = makeUser('user-c', 'compras', 'tenant_a');
const disabled = makeUser('user-d', 'ventas', 'tenant_a', false);
const noRole = makeUser('user-e', undefined, undefined);
const unknownRole = makeUser('user-f', 'inexistente', 'tenant_a');
const n8n = makeUser('n8n', 'ventas', 'tenant_a', true, 'service');
const everyone = [userA, userB, comprador, disabled, noRole, unknownRole, n8n];

const spy = spyDatabase((databaseKey) => ({ columns: ['tenant'], rows: [{ tenant: databaseKey }], rowCount: 1, truncated: false }));
const facturas = { sql: 'SELECT nfacturaventa, ftotal FROM stock.factura_venta' };
let app: TestApp;
let clientA: Client;
let clientB: Client;
let clientC: Client;

beforeAll(async () => {
  app = await startTestApp(everyone, { runSql: spy.runSql });
  clientA = await connectClient(app.url, userA.token);
  clientB = await connectClient(app.url, userB.token);
  clientC = await connectClient(app.url, comprador.token);
});

afterAll(async () => {
  await Promise.all([clientA?.close(), clientB?.close(), clientC?.close()]);
  await app?.close();
});

describe('authentication (HTTP)', () => {
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
  };
  const post = (authorization?: string) =>
    fetch(app.url, {
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
    ['a static token', `Bearer ${'A'.repeat(43)}`],
    ['signature from a key outside the JWKS', `Bearer ${signJwt({ sub: userA.subject }, { key: foreignKey })}`],
    ['alg none', `Bearer ${signJwt({ sub: userA.subject }, { alg: 'none' })}`],
    ['alg HS256', `Bearer ${signJwt({ sub: userA.subject }, { alg: 'HS256' })}`],
    ['expired more than 30 s ago', `Bearer ${signJwt({ sub: userA.subject, exp: now() - 60 })}`],
    ['another issuer', `Bearer ${signJwt({ sub: userA.subject, iss: 'https://other-tenant.test/' })}`],
    ['another audience', `Bearer ${signJwt({ sub: userA.subject, aud: 'https://mcp.test/admin-api' })}`],
    ['no sub', `Bearer ${signJwt({})}`],
  ])('%s → 401 with resource_metadata', async (_case, authorization) => {
    const response = await post(authorization);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('valid token but no access → 403 with the same body for every reason', async () => {
    const tokens = [signJwt({ sub: 'auth0|not-provisioned' }), disabled.token, noRole.token, unknownRole.token];
    const bodies: string[] = [];
    for (const token of tokens) {
      const response = await post(`Bearer ${token}`);
      expect(response.status).toBe(403);
      bodies.push(await response.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain('Forbidden');
  });

  it('disabling a user cuts a still-valid token on the next request', async () => {
    const temp = makeUser('user-temp', 'ventas', 'tenant_a');
    app.users.save(temp.record);
    expect((await post(`Bearer ${temp.token}`)).status).toBe(200);
    app.users.save({ ...temp.record, enabled: false });
    expect((await post(`Bearer ${temp.token}`)).status).toBe(403);
  });

  it('identity comes only from (iss, sub): injected role and databaseKey claims are ignored', async () => {
    const client = await connectClient(app.url, signJwt({ sub: userA.subject, role: 'analista', databaseKey: 'tenant_b' }));
    try {
      spy.calls.length = 0;
      app.toolEvents.length = 0;
      await callTool(client, 'query_sql', facturas);
      expect(spy.calls[0]?.databaseKey).toBe('tenant_a');
      expect(app.toolEvents[0]).toMatchObject({ role: 'ventas', databaseKey: 'tenant_a' });
    } finally {
      await client.close();
    }
  });

  it('a service account (client_credentials) works and is audited as such', async () => {
    const client = await connectClient(app.url, n8n.token);
    try {
      app.toolEvents.length = 0;
      expect((await callTool(client, 'list_circuits')).isError).toBe(false);
      expect(app.toolEvents[0]).toMatchObject({ userId: 'n8n', principalKind: 'service', role: 'ventas' });
    } finally {
      await client.close();
    }
  });

  it.each(['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'])(
    'GET %s → protected resource metadata, without auth',
    async (path) => {
      const response = await fetch(new URL(path, app.url));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ resource: RESOURCE, authorization_servers: [ISSUER], bearer_methods_supported: ['header'] });
    },
  );

  it('POST to the metadata → 405; other paths → 404', async () => {
    expect((await fetch(new URL('/.well-known/oauth-protected-resource/mcp', app.url), { method: 'POST' })).status).toBe(405);
    for (const path of ['/admin', '/data/users.yaml', '/.well-known/openid-configuration']) {
      expect((await fetch(new URL(path, app.url))).status).toBe(404);
    }
  });
});

describe('catalog tools', () => {
  it('exposes exactly three read-only tools; none takes a database', async () => {
    const { tools } = await clientA.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['describe_circuit', 'list_circuits', 'query_sql']);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      const properties = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {});
      for (const forbidden of ['databaseKey', 'database', 'host', 'schema', 'params']) expect(properties).not.toContain(forbidden);
    }
  });

  it('list_circuits returns only the circuits of the role', async () => {
    const a = await callTool(clientA, 'list_circuits');
    expect(a.data.circuits.map((c: { id: string }) => c.id)).toEqual(['venta', 'envio_comprobantes', 'usuario']);
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

  it('describe_circuit: outside the role → AUTHORIZATION_ERROR, unknown → CIRCUIT_NOT_FOUND', async () => {
    expect((await callTool(clientA, 'describe_circuit', { circuit: 'compras' })).data.error.code).toBe('AUTHORIZATION_ERROR');
    expect((await callTool(clientA, 'describe_circuit', { circuit: 'nope' })).data.error.code).toBe('CIRCUIT_NOT_FOUND');
  });

  it('describe_circuit never lists sensitive seguridad columns', async () => {
    const { data } = await callTool(clientA, 'describe_circuit', { circuit: 'usuario' });
    for (const table of data.tables) {
      expect(table.columns).not.toContain('vpassword');
      expect(table.columns).not.toContain('vcodigo2fa');
    }
  });
});

describe('query_sql and tenant isolation', () => {
  it('each user reaches only its own databaseKey, with the SQL untouched', async () => {
    spy.calls.length = 0;
    const a = await callTool(clientA, 'query_sql', facturas);
    const b = await callTool(clientB, 'query_sql', facturas);
    expect(a.data).toEqual({ columns: ['tenant'], rows: [{ tenant: 'tenant_a' }], rowCount: 1, truncated: false });
    expect(b.data.rows).toEqual([{ tenant: 'tenant_b' }]);
    expect(spy.calls).toEqual([
      { databaseKey: 'tenant_a', sql: facturas.sql },
      { databaseKey: 'tenant_b', sql: facturas.sql },
    ]);
  });

  it('a role whose circuits do not cover a table can still query it (the grants decide)', async () => {
    expect((await callTool(clientC, 'query_sql', { sql: 'SELECT ncliente FROM venta.cliente' })).isError).toBe(false);
  });

  it.each([
    ['databaseKey', { ...facturas, databaseKey: 'tenant_b' }],
    ['database', { ...facturas, database: 'tenant_b' }],
    ['host', { ...facturas, host: 'x' }],
    ['schema', { ...facturas, schema: 'x' }],
    ['params', { sql: 'SELECT $1', params: [1] }],
    ['empty sql', { sql: '' }],
    ['missing sql', {}],
  ])('rejects %s before reaching the database', async (_case, args) => {
    spy.calls.length = 0;
    expect((await callTool(clientA, 'query_sql', args)).isError).toBe(true);
    expect(spy.calls).toHaveLength(0);
  });

  it('the description announces the row limit', async () => {
    const tool = (await clientA.listTools()).tools.find((candidate) => candidate.name === 'query_sql');
    expect(tool?.description).toContain('At most 1000 rows');
    expect(Object.keys((tool?.inputSchema as { properties?: object }).properties ?? {})).toEqual(['sql']);
  });

  it('audits hash, length, rows and truncation, never the SQL text or the token', async () => {
    app.toolEvents.length = 0;
    const sql = "SELECT ncliente FROM venta.cliente WHERE vcuit = '20-12345678-9'";
    await callTool(clientA, 'query_sql', { sql });
    expect(app.toolEvents[0]).toMatchObject({
      userId: 'user-a',
      principalKind: 'human',
      role: 'ventas',
      databaseKey: 'tenant_a',
      tool: 'query_sql',
      sqlSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      sqlLength: sql.length,
      rowCount: 1,
      truncated: false,
      success: true,
    });
    const serialized = JSON.stringify(app.toolEvents);
    expect(serialized).not.toContain('20-12345678-9');
    expect(serialized).not.toContain('venta.cliente');
    expect(serialized).not.toContain(userA.token);
  });

  it('audits failures with their error code', async () => {
    app.toolEvents.length = 0;
    await callTool(clientA, 'describe_circuit', { circuit: 'compras' });
    expect(app.toolEvents[0]).toMatchObject({ tool: 'describe_circuit', circuit: 'compras', success: false, errorCode: 'AUTHORIZATION_ERROR' });
  });
});

describe('errors and rate limit', () => {
  it('internal errors are generic: no SQL, no connection string', async () => {
    const leaky = spyDatabase(() => new Error('connect ECONNREFUSED postgres://mcp_popey_ro:s3cret@10.0.0.5:5432/lang SELECT "x" FROM y'));
    const isolated = await startTestApp([userA], { runSql: leaky.runSql });
    const client = await connectClient(isolated.url, userA.token);
    try {
      const outcome = await callTool(client, 'query_sql', facturas);
      expect(outcome.data.error).toEqual({ code: 'INTERNAL_ERROR', message: 'An internal error occurred' });
      expect(JSON.stringify(outcome.data)).not.toMatch(/s3cret|postgres:\/\/|SELECT/);
    } finally {
      await client.close();
      await isolated.close();
    }
  });

  it('returns PostgreSQL diagnostics on SQL errors', async () => {
    const diagnostics = { sqlState: '42601', message: 'syntax error at or near "SELEC"', position: 1 };
    const failing = spyDatabase(() => new AppError('DATABASE_QUERY_ERROR', 'The database could not execute the query', diagnostics));
    const isolated = await startTestApp([userA], { runSql: failing.runSql });
    const client = await connectClient(isolated.url, userA.token);
    try {
      expect((await callTool(client, 'query_sql', { sql: 'SELEC 1' })).data.error).toEqual({
        code: 'DATABASE_QUERY_ERROR',
        message: 'The database could not execute the query',
        diagnostics,
      });
    } finally {
      await client.close();
      await isolated.close();
    }
  });

  it('query_sql consumes quota per user; the catalog tools do not', async () => {
    const limited = await startTestApp([userA, userB], { rateLimit: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }) });
    const a = await connectClient(limited.url, userA.token);
    const b = await connectClient(limited.url, userB.token);
    try {
      expect((await callTool(a, 'query_sql', facturas)).isError).toBe(false);
      expect((await callTool(a, 'query_sql', facturas)).data.error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect((await callTool(a, 'list_circuits')).isError).toBe(false);
      expect((await callTool(b, 'query_sql', facturas)).isError).toBe(false);
    } finally {
      await Promise.all([a.close(), b.close()]);
      await limited.close();
    }
  });
});
