export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
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
