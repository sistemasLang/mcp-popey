import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseRegistry } from '../../api/adapters/outbound/postgres/database.registry.js';
import { buildConfig } from '../../api/config/config.js';
import { APP_ROOT, readEnv } from '../../api/config/env.js';
import { ConfigurationError } from '../../api/domain/errors.js';

/** Minimal valid Auth0 settings: they are required, so every other test spreads them in. */
const AUTH_ENV = {
  AUTH0_DOMAIN: 'empresa.us.auth0.com',
  MCP_RESOURCE_URL: 'https://mcp.empresa.com/mcp',
  ADMIN_API_AUDIENCE: 'https://mcp.empresa.com/admin-api',
  AUTH0_MGMT_CLIENT_ID: 'mgmt-client',
  AUTH0_MGMT_CLIENT_SECRET: 'super-secret-value',
};
const env = (extra: Record<string, string> = {}) => readEnv({ ...AUTH_ENV, ...extra });

describe('query_sql configuration', () => {
  it('defaults to 1000 rows and 30 s', () => {
    expect(buildConfig(env()).sqlQueryLimits).toEqual({ maxRows: 1_000, timeoutMs: 30_000 });
  });

  it('reads QUERY_SQL_MAX_ROWS and QUERY_SQL_TIMEOUT_MS', () => {
    const config = buildConfig(env({ QUERY_SQL_MAX_ROWS: '250', QUERY_SQL_TIMEOUT_MS: '5000' }));
    expect(config.sqlQueryLimits).toEqual({ maxRows: 250, timeoutMs: 5_000 });
  });

  it.each([
    ['QUERY_SQL_MAX_ROWS', '0'],
    ['QUERY_SQL_MAX_ROWS', 'many'],
    ['QUERY_SQL_TIMEOUT_MS', '-1'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => env({ [name]: value })).toThrow(ConfigurationError);
  });

  it('ignores the removed query_circuit variables left in an old .env, even if inconsistent', () => {
    const config = buildConfig(env({ QUERY_MAX_ROWS: '50', QUERY_DEFAULT_ROWS: '600', QUERY_TIMEOUT_MS: '1000' }));
    expect(config.sqlQueryLimits).toEqual({ maxRows: 1_000, timeoutMs: 30_000 });
  });
});

describe('deployment-friendly env', () => {
  it('treats `VAR=` (empty, as in .env.example) as unset instead of port 0 / empty paths', () => {
    const config = buildConfig(
      env({ MCP_HOST: '', MCP_PORT: '', CIRCUITS_FILE: '  ', USERS_FILE: '', QUERY_SQL_MAX_ROWS: '' }),
    );
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3030);
    expect(config.circuitsFile).toBe(resolve(APP_ROOT, 'config/circuits.yaml'));
    expect(config.usersFile).toBe(resolve(APP_ROOT, 'data/users.yaml'));
    expect(config.sqlQueryLimits.maxRows).toBe(1_000);
  });

  it('rejects MCP_PORT=0 explicitly', () => {
    expect(() => env({ MCP_PORT: '0' })).toThrow(ConfigurationError);
  });

  it('resolves relative files from the project root, not the working directory; absolute paths stay', () => {
    expect(APP_ROOT).toBe(fileURLToPath(new URL('../../', import.meta.url)));
    const config = buildConfig(env({ USERS_FILE: '/srv/users.yaml', AUDIT_LOG_FILE: 'logs/audit.jsonl' }));
    expect(config.usersFile).toBe('/srv/users.yaml');
    expect(config.auditLogFile).toBe(resolve(APP_ROOT, 'logs/audit.jsonl'));
  });

  it('DB_<KEY>_* empty values fall back to defaults or report what is missing', () => {
    const base = { DATABASE_KEYS: 'lang', DB_LANG_HOST: 'db', DB_LANG_NAME: 'n', DB_LANG_USER: 'u', DB_LANG_PASSWORD: 'p' };
    const registry = DatabaseRegistry.fromEnv({ ...base, DB_LANG_PORT: '', DB_LANG_SSL: '' });
    expect(registry.get('lang')).toMatchObject({ port: 5432, ssl: false });
    expect(() => DatabaseRegistry.fromEnv({ ...base, DB_LANG_HOST: '' })).toThrow(/DB_LANG_HOST/);
  });
});

describe('Auth0 configuration', () => {
  it('builds the issuer and applies defaults', () => {
    const config = buildConfig(env());
    expect(config.auth).toEqual({
      domain: 'empresa.us.auth0.com',
      issuer: 'https://empresa.us.auth0.com/',
      mcpResourceUrl: 'https://mcp.empresa.com/mcp',
      adminApiAudience: 'https://mcp.empresa.com/admin-api',
      managementClientId: 'mgmt-client',
      managementClientSecret: 'super-secret-value',
      dbConnection: 'Username-Password-Authentication',
      bootstrapAdminEmails: [],
      passwordLinkTtlSeconds: 86_400,
    });
  });

  it.each(['AUTH0_DOMAIN', 'MCP_RESOURCE_URL', 'ADMIN_API_AUDIENCE', 'AUTH0_MGMT_CLIENT_ID', 'AUTH0_MGMT_CLIENT_SECRET'])(
    'fails naming %s when it is missing or empty',
    (name) => {
      expect(() => readEnv({ ...AUTH_ENV, [name]: undefined })).toThrow(new RegExp(name));
      expect(() => readEnv({ ...AUTH_ENV, [name]: '  ' })).toThrow(new RegExp(name));
    },
  );

  it.each([
    ['MCP_RESOURCE_URL', 'http://mcp.empresa.com/mcp'],
    ['MCP_RESOURCE_URL', 'mcp.empresa.com/mcp'],
    ['AUTH0_DOMAIN', 'https://empresa.us.auth0.com'],
    ['PASSWORD_LINK_TTL_SECONDS', '2592000'],
    ['PASSWORD_LINK_TTL_SECONDS', '60'],
    ['BOOTSTRAP_ADMIN_EMAILS', 'ana@empresa.com,not-an-email'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => env({ [name]: value })).toThrow(ConfigurationError);
  });

  it('rejects the same audience for the MCP and the admin API', () => {
    expect(() => env({ ADMIN_API_AUDIENCE: AUTH_ENV.MCP_RESOURCE_URL })).toThrow(/must differ/);
  });

  it('parses BOOTSTRAP_ADMIN_EMAILS lower-cased and the link TTL', () => {
    const config = buildConfig(env({ BOOTSTRAP_ADMIN_EMAILS: ' Ana@Empresa.com, luis@empresa.com ,', PASSWORD_LINK_TTL_SECONDS: '3600' }));
    expect(config.auth.bootstrapAdminEmails).toEqual(['ana@empresa.com', 'luis@empresa.com']);
    expect(config.auth.passwordLinkTtlSeconds).toBe(3_600);
  });

  it('error messages never contain secret values', () => {
    let message = '';
    try {
      readEnv({ ...AUTH_ENV, AUTH0_MGMT_CLIENT_ID: '', MCP_RESOURCE_URL: 'http://leak.example/mcp', BOOTSTRAP_ADMIN_EMAILS: 'bad-value-x' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/AUTH0_MGMT_CLIENT_ID/);
    for (const value of ['super-secret-value', 'leak.example', 'bad-value-x']) expect(message).not.toContain(value);
  });
});
