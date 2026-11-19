import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ConfigurationError } from '../domain/errors.js';
import { SQL_QUERY_LIMITS } from '../domain/security/query-limits.js';

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

const required = z.string({ error: 'is required' }).min(1, 'is required');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Comma-separated emails, lower-cased. Messages never echo the values. */
const emailList = z
  .string()
  .default('')
  .transform((value) => value.split(',').map((email) => email.trim().toLowerCase()).filter(Boolean))
  .refine((emails) => emails.every((email) => EMAIL.test(email)), 'must be a comma-separated list of valid emails');

const EnvSchema = z.object({
  AUTH0_DOMAIN: required.regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i, 'must be a host name such as empresa.us.auth0.com (no scheme)'),
  MCP_RESOURCE_URL: required.refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.search && !url.hash;
    } catch {
      return false;
    }
  }, 'must be an absolute https URL (the public URL of /mcp)'),
  ADMIN_API_AUDIENCE: required,
  AUTH0_MGMT_CLIENT_ID: required,
  AUTH0_MGMT_CLIENT_SECRET: required,
  AUTH0_DB_CONNECTION: z.string().default('Username-Password-Authentication'),
  BOOTSTRAP_ADMIN_EMAILS: emailList,
  PASSWORD_LINK_TTL_SECONDS: z.coerce.number().int().min(300).max(604_800).default(86_400),

  MCP_HOST: z.string().default('127.0.0.1'),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(3030),
  CIRCUITS_FILE: rootPath('config/circuits.yaml'),
  CIRCUIT_ACCESS_FILE: rootPath('config/circuit-access.yaml'),
  USERS_FILE: rootPath('data/users.yaml'),
  AUDIT_LOG_FILE: z.string().transform(resolveFromRoot).optional(),

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
  if (result.data.ADMIN_API_AUDIENCE === result.data.MCP_RESOURCE_URL) {
    throw new ConfigurationError('ADMIN_API_AUDIENCE must differ from MCP_RESOURCE_URL');
  }
  return result.data;
}
