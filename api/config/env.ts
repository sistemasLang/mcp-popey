import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ConfigurationError } from '../domain/errors.js';
import { QUERY_LIMITS, SQL_QUERY_LIMITS } from '../domain/security/query-limits.js';

/**
 * Project root (the folder holding package.json, config/ and data/), from this
 * file's location: api/config or dist/config → ../.. . Relative paths are
 * resolved against it, never against the current directory, so the server and
 * the CLI find the same .env and users.yaml wherever they are launched from.
 */
export const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export function resolveFromRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(APP_ROOT, path);
}

/** Loads `<APP_ROOT>/.env` if present (real env vars, e.g. from pm2, win). */
export function loadDotEnv(path = resolveFromRoot('.env')): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

/**
 * `VAR=` in .env means "not set": use the default. Without this, MCP_PORT=
 * would coerce to port 0 (a random port) and DB_X_SSL= would fail validation.
 */
export function withoutEmptyValues(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''));
}

/** A file path; relative values are taken from APP_ROOT. */
const rootPath = (fallback: string) => z.string().default(fallback).transform(resolveFromRoot);

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const EnvSchema = z.object({
  MCP_HOST: z.string().default('127.0.0.1'),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(3030),
  CIRCUITS_FILE: rootPath('config/circuits.yaml'),
  CIRCUIT_ACCESS_FILE: rootPath('config/circuit-access.yaml'),
  USERS_FILE: rootPath('data/users.yaml'),
  AUDIT_LOG_FILE: z.string().transform(resolveFromRoot).optional(),

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
  const result = EnvSchema.safeParse(withoutEmptyValues(source));
  if (!result.success) {
    throw new ConfigurationError(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  if (result.data.QUERY_DEFAULT_ROWS > result.data.QUERY_MAX_ROWS) {
    throw new ConfigurationError('QUERY_DEFAULT_ROWS cannot be greater than QUERY_MAX_ROWS');
  }
  return result.data;
}
