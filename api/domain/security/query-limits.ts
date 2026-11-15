export interface QueryLimits {
  defaultRows: number;
  maxRows: number;
  maxSelectedColumns: number;
  maxFilters: number;
  maxOrderBy: number;
  maxInValues: number;
  maxValueLength: number;
  timeoutMs: number;
}

/** Defaults; every value can be overridden through env (see config/env.ts). */
export const QUERY_LIMITS: Readonly<QueryLimits> = Object.freeze({
  defaultRows: 100,
  maxRows: 500,
  maxSelectedColumns: 30,
  maxFilters: 20,
  maxOrderBy: 5,
  maxInValues: 100,
  maxValueLength: 500,
  timeoutMs: 10_000,
});

/** Limits of query_sql (free read-only SQL). The SQL itself is never rewritten. */
export interface SqlQueryLimits {
  /** Rows returned at most; beyond that the result is marked truncated. */
  maxRows: number;
  timeoutMs: number;
}

export const SQL_QUERY_LIMITS: Readonly<SqlQueryLimits> = Object.freeze({
  maxRows: 1_000,
  timeoutMs: 30_000,
});
