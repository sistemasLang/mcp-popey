import type { SqlQueryLimits } from '../domain/security/query-limits.js';
import type { Env } from './env.js';

export interface AppConfig {
  host: string;
  port: number;
  circuitsFile: string;
  circuitAccessFile: string;
  usersFile: string;
  auditLogFile?: string;
  sqlQueryLimits: SqlQueryLimits;
  rateLimit: { maxRequests: number; windowMs: number };
  dbPoolMax: number;
  auth: AuthConfig;
}

export interface AuthConfig {
  domain: string;
  /** `https://<AUTH0_DOMAIN>/`: exact `iss` of every accepted token. */
  issuer: string;
  mcpResourceUrl: string;
  adminApiAudience: string;
  managementClientId: string;
  managementClientSecret: string;
  dbConnection: string;
  bootstrapAdminEmails: string[];
  passwordLinkTtlSeconds: number;
}

export function buildConfig(env: Env): AppConfig {
  return {
    auth: {
      domain: env.AUTH0_DOMAIN,
      issuer: `https://${env.AUTH0_DOMAIN}/`,
      mcpResourceUrl: env.MCP_RESOURCE_URL,
      adminApiAudience: env.ADMIN_API_AUDIENCE,
      managementClientId: env.AUTH0_MGMT_CLIENT_ID,
      managementClientSecret: env.AUTH0_MGMT_CLIENT_SECRET,
      dbConnection: env.AUTH0_DB_CONNECTION,
      bootstrapAdminEmails: env.BOOTSTRAP_ADMIN_EMAILS,
      passwordLinkTtlSeconds: env.PASSWORD_LINK_TTL_SECONDS,
    },
    host: env.MCP_HOST,
    port: env.MCP_PORT,
    circuitsFile: env.CIRCUITS_FILE,
    circuitAccessFile: env.CIRCUIT_ACCESS_FILE,
    usersFile: env.USERS_FILE,
    auditLogFile: env.AUDIT_LOG_FILE,
    sqlQueryLimits: { maxRows: env.QUERY_SQL_MAX_ROWS, timeoutMs: env.QUERY_SQL_TIMEOUT_MS },
    rateLimit: { maxRequests: env.RATE_LIMIT_MAX_REQUESTS, windowMs: env.RATE_LIMIT_WINDOW_MS },
    dbPoolMax: env.DB_POOL_MAX,
  };
}
