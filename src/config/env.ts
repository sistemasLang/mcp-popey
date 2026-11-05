import { existsSync } from 'node:fs';
import { z } from 'zod';
import { ConfigurationError } from '../errors/app-errors.js';
import { QUERY_LIMITS, SQL_QUERY_LIMITS } from '../security/query-limits.js';

/** Loads `.env` from the working directory if present (real env vars win). */
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const EnvSchema = z.object({
  MCP_HOST: z.string().default('127.0.0.1'),
  MCP_PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  CIRCUITS_FILE: z.string().default('config/circuits.yaml'),
  CIRCUIT_ACCESS_FILE: z.string().default('config/circuit-access.yaml'),
  USERS_FILE: z.string().default('data/users.yaml'),
  AUDIT_LOG_FILE: z.string().optional(),

  QUERY_DEFAULT_ROWS: positiveInt(QUERY_LIMITS.defaultRows),
  QUERY_MAX_ROWS: positiveInt(QUERY_LIMITS.maxRows),
  QUERY_MAX_SELECTED_COLUMNS: positiveInt(QUERY_LIMITS.maxSelectedColumns),
  QUERY_MAX_FILTERS: positiveInt(QUERY_LIMITS.maxFilters),
  QUERY_MAX_ORDER_BY: positiveInt(QUERY_LIMITS.maxOrderBy),
  QUERY_MAX_IN_VALUES: positiveInt(QUERY_LIMITS.maxInValues),
  QUERY_MAX_VALUE_LENGTH: positiveInt(QUERY_LIMITS.maxValueLength),
  QUERY_TIMEOUT_MS: positiveInt(QUERY_LIMITS.timeoutMs),

  QUERY_SQL_MAX_ROWS: positiveInt(SQL_QUERY_LIMITS.maxRows),
  QUERY_SQL_TIMEOUT_MS: positiveInt(SQL_QUERY_LIMITS.timeoutMs),

  RATE_LIMIT_MAX_REQUESTS: positiveInt(30),
  RATE_LIMIT_WINDOW_MS: positiveInt(60_000),

  DB_POOL_MAX: positiveInt(5),
});

export type Env = z.infer<typeof EnvSchema>;

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new ConfigurationError(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  if (result.data.QUERY_DEFAULT_ROWS > result.data.QUERY_MAX_ROWS) {
    throw new ConfigurationError('QUERY_DEFAULT_ROWS cannot be greater than QUERY_MAX_ROWS');
  }
  return result.data;
}
