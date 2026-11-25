import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { adminUser, mcpUser } from '../../api/auth.js';
import { createUserStore, InvalidUserError } from '../../api/users.js';
import { parseCatalog } from '../../api/circuits.js';
import { APP_ROOT, loadConfig } from '../../api/config.js';
import { toSqlError } from '../../api/db.js';
import { AppError, ConfigError, redactCredentials, toPublicError } from '../../api/errors.js';
import { createRateLimiter } from '../../api/tools/query-sql.js';
import { CIRCUITS_FILE, ISSUER, makeAdmin, makeUser, tempUserStore, testCatalog } from '../helpers.js';

describe('config', () => {
  const base = {
    AUTH0_DOMAIN: 'empresa.us.auth0.com',
    MCP_RESOURCE_URL: 'https://mcp.example.com/mcp',
    ADMIN_API_AUDIENCE: 'https://mcp.example.com/admin-api',
    AUTH0_MGMT_CLIENT_ID: 'mgmt-id',
    AUTH0_MGMT_CLIENT_SECRET: 'mgmt-s3cret',
  };

  it('builds the issuer and applies defaults; `VAR=` counts as unset', () => {
    const config = loadConfig({ ...base, MCP_PORT: '', QUERY_SQL_MAX_ROWS: ' ', PASSWORD_LINK_TTL_SECONDS: '' });
    expect(config).toMatchObject({ issuer: 'https://empresa.us.auth0.com/', port: 3030, host: '127.0.0.1', maxRows: 1_000, timeoutMs: 30_000 });
    expect(config.auth0).toMatchObject({ connection: 'Username-Password-Authentication', passwordLinkTtlSeconds: 86_400 });
    expect(config.usersFile).toBe(join(APP_ROOT, 'data/users.yaml'));
  });

  it('requires Auth0 settings and an https resource URL', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, AUTH0_MGMT_CLIENT_SECRET: '' })).toThrow(/AUTH0_MGMT_CLIENT_SECRET/);
    expect(() => loadConfig({ ...base, MCP_RESOURCE_URL: 'http://mcp.example.com/mcp' })).toThrow(/https/);
    expect(() => loadConfig({ ...base, AUTH0_DOMAIN: 'https://empresa.us.auth0.com' })).toThrow(/host name/);
  });

  it('rejects the same audience for /mcp and the admin API', () => {
    expect(() => loadConfig({ ...base, ADMIN_API_AUDIENCE: base.MCP_RESOURCE_URL })).toThrow(/must differ/);
  });

  it('parses BOOTSTRAP_ADMIN_EMAILS lower-cased; errors never echo secrets', () => {
    expect(loadConfig({ ...base, BOOTSTRAP_ADMIN_EMAILS: ' Ana@Empresa.com, b@c.io ' }).bootstrapAdminEmails).toEqual(['ana@empresa.com', 'b@c.io']);
    expect(() => loadConfig({ ...base, BOOTSTRAP_ADMIN_EMAILS: 'no-es-mail' })).toThrow(/valid emails/);
    expect(() => loadConfig({ ...base, PASSWORD_LINK_TTL_SECONDS: '1' })).not.toThrow(/mgmt-s3cret/);
  });

  it('reads tenant databases and reports missing variables without echoing values', () => {
    const env = { ...base, DATABASE_KEYS: 'lang', DB_LANG_HOST: 'h', DB_LANG_NAME: 'n', DB_LANG_USER: 'u', DB_LANG_PASSWORD: 'p4ss', DB_LANG_PORT: '' };
    expect(loadConfig(env).databases.get('lang')).toEqual({ host: 'h', port: 5432, database: 'n', user: 'u', password: 'p4ss', ssl: false });
    const broken = () => loadConfig({ ...env, DB_LANG_HOST: '' });
    expect(broken).toThrow(/DB_LANG_HOST/);
    expect(broken).not.toThrow(/p4ss/);
    expect(() => loadConfig({ ...base, DATABASE_KEYS: 'Mal-Key' })).toThrow(/Invalid database key/);
  });
});

describe('catalog', () => {
  const REVIEW_CASES = `
circuits:
  review_cases:
    description: "tables that must be marked not queryable"
    tables:
      - { table: stock.articulo, role: needs_review, key_columns: [narticulo], status: needs_review }
      - { table: stock.factura_compra, role: legacy, key_columns: [nfacturacompra, "..."], status: [needs_review, legacy] }
      - { table: stock.facturacompraxitem, role: empty, key_columns: [] }
      - { table: venta.cuenta_corriente, role: prose, key_columns: ["columnas no confirmadas en detalle"] }
      - { table: e_plataforma.bridge, role: mixed, key_columns: [nbridge, "accessKey (no confirmado)"] }
      - { table: compra.items, role: pending, key_columns: [narticulo, fimpinterno] }
      - { table: stock.raro, role: unknown status, key_columns: [a], status: experimental }
      - { table: stock.doble, role: first, key_columns: [a] }
      - { table: stock.doble, role: second, key_columns: [b], status: legacy }
    pending_columns:
      - { table: compra.items, column: fimpinterno, status: not_implemented }
`;
  const tables = parseCatalog(REVIEW_CASES, 'roles: { r: { circuits: [review_cases] } }').circuits.get('review_cases')!.tables;
  const table = (name: string) => tables.find((t) => t.table === name)!;

  it('loads the real circuits.yaml with the shipped example roles', () => {
    const access = readFileSync(CIRCUITS_FILE.replace('circuits.yaml', 'circuit-access.example.yaml'), 'utf8');
    expect(parseCatalog(readFileSync(CIRCUITS_FILE, 'utf8'), access).circuits.size).toBeGreaterThan(5);
  });

  it('deny by default: needs_review, legacy, unknown status and no confirmed columns are not queryable', () => {
    expect(table('stock.articulo')).toMatchObject({ queryable: false, notQueryableReasons: ['needs_review'] });
    expect(table('stock.factura_compra').notQueryableReasons).toEqual(['needs_review', 'legacy']);
    expect(table('stock.raro').notQueryableReasons).toEqual(['unknown_status']);
    expect(table('stock.facturacompraxitem').notQueryableReasons).toEqual(['no_confirmed_columns']);
    expect(table('venta.cuenta_corriente').notQueryableReasons).toEqual(['no_confirmed_columns']);
    expect(table('stock.articulo').columns).toBeUndefined();
  });

  it('prose key_columns are dropped; pending columns are removed and shown as information', () => {
    expect(table('e_plataforma.bridge').columns).toEqual(['nbridge']);
    expect(table('compra.items')).toMatchObject({ queryable: true, columns: ['narticulo'], pendingColumns: [{ column: 'fimpinterno' }] });
  });

  it('a table repeated in one circuit is merged, and the restriction wins', () => {
    expect(tables.filter((t) => t.table === 'stock.doble')).toHaveLength(1);
    expect(table('stock.doble')).toMatchObject({ queryable: false, description: 'first | second' });
  });

  it('refuses a role that references an unknown circuit, and a structurally invalid file', () => {
    expect(() => parseCatalog(REVIEW_CASES, 'roles: { r: { circuits: [typo] } }')).toThrow(/unknown circuits: typo/);
    expect(() => parseCatalog('circuits: { c: { description: x, tables: [{ table: NoSchema, role: x }] } }', 'roles:')).toThrow(ConfigError);
    expect(() => parseCatalog(REVIEW_CASES, 'roles: { r: { circuits: [], sql: true } }')).toThrow(ConfigError);
  });

  it('create_readonly_role.sql grants on seguridad exactly the usuario circuit columns', () => {
    const script = readFileSync(fileURLToPath(new URL('../../scripts/create_readonly_role.sql', import.meta.url)), 'utf8');
    const granted = new Map(
      [...script.matchAll(/\('(\w+)', ARRAY\[([^\]]*)\]\)/g)].map(([, name, columns]) => [
        `seguridad.${name}`,
        [...(columns ?? '').matchAll(/'(\w+)'/g)].map(([, column]) => column),
      ]),
    );
    const documented = testCatalog().circuits.get('usuario')!.tables;
    expect([...granted.keys()].sort()).toEqual(documented.map((t) => t.table).sort());
    for (const t of documented) expect(granted.get(t.table), t.table).toEqual(t.columns);
  });

  it('no circuit lists secret or sensitive columns', () => {
    const sensitive = ['vpassword', 'vhashrecupclave', 'vcodigo2fa', 'dfechanacimiento', 'vaccesskey', 'vsecretkey', 'vaccesstoken', 'vrefreshtoken'];
    for (const circuit of testCatalog().circuits.values()) {
      for (const t of circuit.tables) for (const column of sensitive) expect(t.columns ?? [], `${t.table}.${column}`).not.toContain(column);
    }
  });
});

describe('users.yaml', () => {
  const file = () => join(mkdtempSync(join(tmpdir(), 'users-')), 'users.yaml');

  it('a missing file means nobody has access', () => {
    expect(mcpUser(createUserStore(file()), ISSUER, 'auth0|x')).toBeNull();
  });

  it('/mcp: only enabled users with role + databaseKey, by (issuer, subject)', () => {
    const ok = makeUser('ok', 'ventas', 'lang');
    const store = tempUserStore([ok, makeUser('off', 'ventas', 'lang', false), makeUser('norole', undefined, undefined)]);
    expect(mcpUser(store, ISSUER, ok.subject)).toEqual({ id: 'ok', kind: 'human', role: 'ventas', databaseKey: 'lang' });
    expect(mcpUser(store, 'https://other/', ok.subject)).toBeNull();
    expect(mcpUser(store, ISSUER, 'auth0|off')).toBeNull();
    expect(mcpUser(store, ISSUER, 'auth0|norole')).toBeNull();
  });

  it('/admin/api: only enabled people with admin: true', () => {
    const store = tempUserStore([makeAdmin('ana'), makeAdmin('ex', {}, false), makeUser('vendedor', 'ventas', 'lang')]);
    expect(adminUser(store, ISSUER, 'auth0|ana')?.id).toBe('ana');
    expect(adminUser(store, ISSUER, 'auth0|ex')).toBeNull();
    expect(adminUser(store, ISSUER, 'auth0|vendedor')).toBeNull();
  });

  it('saves atomically with mode 0600 and re-reads manual edits', () => {
    const path = file();
    const store = createUserStore(path);
    store.save(makeUser('a', 'ventas', 'lang').record);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(path, readFileSync(path, 'utf8').replace('enabled: true', 'enabled: false'));
    utimesSync(path, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    expect(store.findById('a')?.enabled).toBe(false);
  });

  it('refuses to save an identity already linked to another user, or role without databaseKey', () => {
    const a = makeUser('a', 'ventas', 'lang');
    const store = tempUserStore([a]);
    expect(() => store.save({ ...makeUser('b', 'ventas', 'lang').record, identities: a.record.identities })).toThrow(InvalidUserError);
    expect(() => store.save(makeUser('c', 'ventas', undefined).record)).toThrow(/role and databaseKey/);
    expect(store.list().map((user) => user.id)).toEqual(['a']);
  });

  it('returns copies: mutating a result does not change the store', () => {
    const store = tempUserStore([makeUser('a', 'ventas', 'lang')]);
    store.findById('a')!.enabled = false;
    expect(store.findById('a')?.enabled).toBe(true);
  });

  it('refuses the old v1 format (static tokens)', () => {
    const path = file();
    writeFileSync(path, 'users:\n  - name: x\n    tokenSha256: abc\n');
    expect(() => createUserStore(path).list()).toThrow(ConfigError);
  });
});

describe('PostgreSQL errors → public errors', () => {
  const pgError = (code: string, message: string, extra: { hint?: string; position?: string } = {}) => {
    const error = new pg.DatabaseError(message, 0, 'error');
    error.code = code;
    Object.assign(error, extra);
    return error;
  };

  it('maps SQLSTATE to a public code and keeps PostgreSQL diagnostics', () => {
    expect(toPublicError(toSqlError(pgError('42601', 'syntax error at or near "SELEC"', { position: '1' })))).toEqual({
      code: 'DATABASE_QUERY_ERROR',
      message: 'The database could not execute the query',
      diagnostics: { sqlState: '42601', message: 'syntax error at or near "SELEC"', position: 1 },
    });
    expect(toSqlError(pgError('42501', 'permission denied')).code).toBe('AUTHORIZATION_ERROR');
    expect(toSqlError(pgError('57014', 'canceling statement')).code).toBe('QUERY_TIMEOUT');
    expect(toSqlError(pgError('22P02', 'invalid input')).code).toBe('INVALID_QUERY');
  });

  it('redacts credentials in the diagnostics', () => {
    const error = toSqlError(pgError('42703', 'column x near postgres://u:s3cret@h/db', { hint: 'postgres://u:s3cret@h/db' }));
    expect(JSON.stringify(toPublicError(error))).not.toContain('s3cret');
  });

  it('a broken socket is generic, without diagnostics', () => {
    expect(toPublicError(toSqlError(new Error('Connection terminated')))).toEqual({
      code: 'DATABASE_QUERY_ERROR',
      message: 'The database could not execute the query',
    });
  });

  it('a non-AppError never reaches the client', () => {
    expect(toPublicError(new Error('postgres://u:s3cret@h'))).toEqual({ code: 'INTERNAL_ERROR', message: 'An internal error occurred' });
    expect(toPublicError(new AppError('RATE_LIMIT_EXCEEDED', 'slow down'))).toEqual({ code: 'RATE_LIMIT_EXCEEDED', message: 'slow down' });
  });

  it('redactCredentials hides URL passwords only', () => {
    expect(redactCredentials('failed postgres://mcp_popey_ro:s3cr3t@10.0.0.5:5432/lang')).toBe('failed postgres://mcp_popey_ro:***@10.0.0.5:5432/lang');
    expect(redactCredentials('no secrets here')).toBe('no secrets here');
  });
});

describe('rate limiter', () => {
  it('is a sliding window per user', () => {
    let now = 0;
    const consume = createRateLimiter({ maxRequests: 2, windowMs: 1_000 }, () => now);
    consume('u');
    now = 900;
    consume('u');
    expect(() => consume('u')).toThrow(/Rate limit/);
    expect(() => consume('other')).not.toThrow();
    now = 1_001; // first hit expired, second still inside
    consume('u');
    expect(() => consume('u')).toThrow(/Rate limit/);
  });
});
