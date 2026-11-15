/**
 * What the application needs from a tenant database. The target is always a
 * databaseKey taken from UserContext; implementations decide how to reach it
 * and must guarantee that nothing is ever written.
 */
export interface ReadOnlyDatabasePort {
  /** Runs a parameterized SELECT compiled by QueryCompiler (query_circuit). */
  executeSelect(databaseKey: string, sql: string, params: unknown[], options: SelectOptions): Promise<SelectResult>;
  /** Runs one read-only statement written by the model (query_sql). */
  executeSql(databaseKey: string, sql: string, options: SqlOptions): Promise<SqlResult>;
}

export interface SelectResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

export interface SelectOptions {
  timeoutMs: number;
}

export interface SqlOptions {
  timeoutMs: number;
  /** Rows returned at most; one more is read to know whether there were more. */
  maxRows: number;
}

export interface SqlResult {
  /** Column names in the order the statement returns them. */
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}
