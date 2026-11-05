import { describe, expect, it } from 'vitest';
import { buildConfig } from '../../src/config/config.js';
import { readEnv } from '../../src/config/env.js';
import { ConfigurationError } from '../../src/errors/app-errors.js';

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
