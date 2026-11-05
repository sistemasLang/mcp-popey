import type { QueryLimits, SqlQueryLimits } from '../security/query-limits.js';
import type { Env } from './env.js';

export interface AppConfig {
  host: string;
  port: number;
  circuitsFile: string;
  circuitAccessFile: string;
  usersFile: string;
  auditLogFile?: string;
  queryLimits: QueryLimits;
  sqlQueryLimits: SqlQueryLimits;
  rateLimit: { maxRequests: number; windowMs: number };
  dbPoolMax: number;
}

export function buildConfig(env: Env): AppConfig {
  return {
    host: env.MCP_HOST,
    port: env.MCP_PORT,
    circuitsFile: env.CIRCUITS_FILE,
    circuitAccessFile: env.CIRCUIT_ACCESS_FILE,
    usersFile: env.USERS_FILE,
    auditLogFile: env.AUDIT_LOG_FILE,
    queryLimits: {
      defaultRows: env.QUERY_DEFAULT_ROWS,
      maxRows: env.QUERY_MAX_ROWS,
      maxSelectedColumns: env.QUERY_MAX_SELECTED_COLUMNS,
      maxFilters: env.QUERY_MAX_FILTERS,
      maxOrderBy: env.QUERY_MAX_ORDER_BY,
      maxInValues: env.QUERY_MAX_IN_VALUES,
      maxValueLength: env.QUERY_MAX_VALUE_LENGTH,
      timeoutMs: env.QUERY_TIMEOUT_MS,
    },
    sqlQueryLimits: { maxRows: env.QUERY_SQL_MAX_ROWS, timeoutMs: env.QUERY_SQL_TIMEOUT_MS },
    rateLimit: { maxRequests: env.RATE_LIMIT_MAX_REQUESTS, windowMs: env.RATE_LIMIT_WINDOW_MS },
    dbPoolMax: env.DB_POOL_MAX,
  };
}
