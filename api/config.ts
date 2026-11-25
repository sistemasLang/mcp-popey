import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ConfigError } from './errors.js';

/**
 * Everything the server reads from the environment (.env + process env), validated
 * once at startup. A missing or invalid value stops the server before it listens.
 */

/** Project root (api/ or dist/ → ..). Relative paths are resolved from here, not from the cwd. */
export const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));

const fromRoot = (path: string) => (isAbsolute(path) ? path : resolve(APP_ROOT, path));
const filePath = (fallback: string) => z.string().default(fallback).transform(fromRoot);
const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const required = z.string({ error: 'is required' }).min(1, 'is required');

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
  BOOTSTRAP_ADMIN_EMAILS: z
    .string()
    .default('')
    .transform((value) => value.split(',').map((email) => email.trim().toLowerCase()).filter(Boolean))
    .refine((emails) => emails.every((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)), 'must be a comma-separated list of valid emails'),
  PASSWORD_LINK_TTL_SECONDS: z.coerce.number().int().min(300).max(604_800).default(86_400),

  MCP_HOST: z.string().default('127.0.0.1'),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(3030),

  CIRCUITS_FILE: filePath('config/circuits.yaml'),
  CIRCUIT_ACCESS_FILE: filePath('config/circuit-access.yaml'),
  USERS_FILE: filePath('data/users.yaml'),
  AUDIT_LOG_FILE: z.string().transform(fromRoot).optional(),

  QUERY_SQL_MAX_ROWS: positiveInt(1_000),
  QUERY_SQL_TIMEOUT_MS: positiveInt(30_000),
  RATE_LIMIT_MAX_REQUESTS: positiveInt(30),
  RATE_LIMIT_WINDOW_MS: positiveInt(60_000),
  DB_POOL_MAX: positiveInt(5),
});

const DatabaseSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535).default(5432),
  database: z.string().min(1),
  user: z.string().min(1),
  password: z.string().min(1),
  ssl: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
});

/** Connection settings of one tenant database. Never sent to a client nor logged. */
export type DatabaseConfig = z.infer<typeof DatabaseSchema>;

export interface Config {
  host: string;
  port: number;
  /** `https://<AUTH0_DOMAIN>/`: the exact `iss` of every accepted token. */
  issuer: string;
  /** Public URL of /mcp: the required `aud` of /mcp tokens. */
  resourceUrl: string;
  /** Required `aud` of admin panel tokens. Must differ from resourceUrl. */
  adminAudience: string;
  /** Auth0 Management API (admin panel): M2M app of this server. */
  auth0: { domain: string; clientId: string; clientSecret: string; connection: string; passwordLinkTtlSeconds: number };
  bootstrapAdminEmails: string[];
  circuitsFile: string;
  circuitAccessFile: string;
  usersFile: string;
  auditLogFile?: string;
  maxRows: number;
  timeoutMs: number;
  rateLimit: { maxRequests: number; windowMs: number };
  poolMax: number;
  /** databaseKey → connection. The key only ever comes from the user's record in users.yaml. */
  databases: Map<string, DatabaseConfig>;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  // `VAR=` in .env means "not set": use the default (otherwise MCP_PORT= would become port 0).
  const env = Object.fromEntries(Object.entries(source).filter(([, value]) => value?.trim()));
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) throw new ConfigError(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  const e = parsed.data;
  // Same audience would let a panel token work on /mcp and the other way round.
  if (e.ADMIN_API_AUDIENCE === e.MCP_RESOURCE_URL) throw new ConfigError('ADMIN_API_AUDIENCE must differ from MCP_RESOURCE_URL');

  return {
    host: e.MCP_HOST,
    port: e.MCP_PORT,
    issuer: `https://${e.AUTH0_DOMAIN}/`,
    resourceUrl: e.MCP_RESOURCE_URL,
    adminAudience: e.ADMIN_API_AUDIENCE,
    auth0: {
      domain: e.AUTH0_DOMAIN,
      clientId: e.AUTH0_MGMT_CLIENT_ID,
      clientSecret: e.AUTH0_MGMT_CLIENT_SECRET,
      connection: e.AUTH0_DB_CONNECTION,
      passwordLinkTtlSeconds: e.PASSWORD_LINK_TTL_SECONDS,
    },
    bootstrapAdminEmails: e.BOOTSTRAP_ADMIN_EMAILS,
    circuitsFile: e.CIRCUITS_FILE,
    circuitAccessFile: e.CIRCUIT_ACCESS_FILE,
    usersFile: e.USERS_FILE,
    auditLogFile: e.AUDIT_LOG_FILE,
    maxRows: e.QUERY_SQL_MAX_ROWS,
    timeoutMs: e.QUERY_SQL_TIMEOUT_MS,
    rateLimit: { maxRequests: e.RATE_LIMIT_MAX_REQUESTS, windowMs: e.RATE_LIMIT_WINDOW_MS },
    poolMax: e.DB_POOL_MAX,
    databases: readDatabases(env),
  };
}

/** `DATABASE_KEYS=lang,cliente_b` plus DB_<KEY>_HOST / _PORT / _NAME / _USER / _PASSWORD / _SSL per key. */
function readDatabases(env: Record<string, string | undefined>): Map<string, DatabaseConfig> {
  const keys = (env.DATABASE_KEYS ?? '').split(',').map((key) => key.trim()).filter(Boolean);
  const databases = new Map<string, DatabaseConfig>();
  for (const key of keys) {
    if (!/^[a-z0-9_]{1,32}$/.test(key)) throw new ConfigError(`Invalid database key "${key}": use 1-32 chars [a-z0-9_]`);
    const prefix = `DB_${key.toUpperCase()}_`;
    const result = DatabaseSchema.safeParse({
      host: env[`${prefix}HOST`],
      port: env[`${prefix}PORT`],
      database: env[`${prefix}NAME`],
      user: env[`${prefix}USER`],
      password: env[`${prefix}PASSWORD`],
      ssl: env[`${prefix}SSL`],
    });
    if (!result.success) {
      // Names the missing variables, never their values.
      const names = { host: 'HOST', port: 'PORT', database: 'NAME', user: 'USER', password: 'PASSWORD', ssl: 'SSL' };
      const missing = result.error.issues.map((issue) => prefix + names[issue.path[0] as keyof typeof names]);
      throw new ConfigError(`Incomplete database configuration for "${key}": ${missing.join(', ')}`);
    }
    databases.set(key, result.data);
  }
  return databases;
}

/** Loads `<APP_ROOT>/.env` if it exists. Variables already set (e.g. by pm2) win. */
export function loadDotEnv(): void {
  const path = fromRoot('.env');
  if (existsSync(path)) process.loadEnvFile(path);
}
