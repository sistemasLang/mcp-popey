/** Limits of query_sql (free read-only SQL). The SQL itself is never rewritten. */
export interface SqlQueryLimits {
  /** Rows returned at most; beyond that the result is marked truncated. */
  maxRows: number;
  timeoutMs: number;
}

/** Defaults; every value can be overridden through env (see config/env.ts). */
export const SQL_QUERY_LIMITS: Readonly<SqlQueryLimits> = Object.freeze({
  maxRows: 1_000,
  timeoutMs: 30_000,
});
