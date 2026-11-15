import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseRegistry } from '../../api/adapters/outbound/postgres/database.registry.js';
import { buildConfig } from '../../api/config/config.js';
import { APP_ROOT, readEnv } from '../../api/config/env.js';
import { ConfigurationError } from '../../api/domain/errors.js';

describe('query_sql configuration', () => {
  it('defaults to 1000 rows and 30 s', () => {
    expect(buildConfig(readEnv({})).sqlQueryLimits).toEqual({ maxRows: 1_000, timeoutMs: 30_000 });
  });

  it('reads QUERY_SQL_MAX_ROWS and QUERY_SQL_TIMEOUT_MS', () => {
    const config = buildConfig(readEnv({ QUERY_SQL_MAX_ROWS: '250', QUERY_SQL_TIMEOUT_MS: '5000' }));
    expect(config.sqlQueryLimits).toEqual({ maxRows: 250, timeoutMs: 5_000 });
  });

  it.each([
    ['QUERY_SQL_MAX_ROWS', '0'],
    ['QUERY_SQL_MAX_ROWS', 'many'],
    ['QUERY_SQL_TIMEOUT_MS', '-1'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => readEnv({ [name]: value })).toThrow(ConfigurationError);
  });

  it('is independent from the query_circuit limits', () => {
    const config = buildConfig(readEnv({ QUERY_MAX_ROWS: '50', QUERY_DEFAULT_ROWS: '10', QUERY_TIMEOUT_MS: '1000' }));
    expect(config.sqlQueryLimits).toEqual({ maxRows: 1_000, timeoutMs: 30_000 });
  });
});

describe('deployment-friendly env', () => {
  it('treats `VAR=` (empty, as in .env.example) as unset instead of port 0 / empty paths', () => {
    const config = buildConfig(
      readEnv({ MCP_HOST: '', MCP_PORT: '', CIRCUITS_FILE: '  ', USERS_FILE: '', QUERY_SQL_MAX_ROWS: '' }),
    );
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3030);
    expect(config.circuitsFile).toBe(resolve(APP_ROOT, 'config/circuits.yaml'));
    expect(config.usersFile).toBe(resolve(APP_ROOT, 'data/users.yaml'));
    expect(config.sqlQueryLimits.maxRows).toBe(1_000);
  });

  it('rejects MCP_PORT=0 explicitly', () => {
    expect(() => readEnv({ MCP_PORT: '0' })).toThrow(ConfigurationError);
  });

  it('resolves relative files from the project root, not the working directory; absolute paths stay', () => {
    expect(APP_ROOT).toBe(fileURLToPath(new URL('../../', import.meta.url)));
    const config = buildConfig(readEnv({ USERS_FILE: '/srv/users.yaml', AUDIT_LOG_FILE: 'logs/audit.jsonl' }));
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
