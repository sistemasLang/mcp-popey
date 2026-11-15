/**
 * One record per tool call. Never contains the bearer token, passwords,
 * connection strings, filter values, SQL text or result rows.
 */
export interface AuditEvent {
  timestamp: string;
  userId: string;
  role: string;
  databaseKey: string;
  tool: string;
  circuit?: string;
  table?: string;
  columns?: string[];
  filterFields?: string[];
  rowCount?: number;
  /** query_sql: SHA-256 hex and length of the SQL text (never the text itself). */
  sqlSha256?: string;
  sqlLength?: number;
  /** query_sql: more rows existed than were returned. */
  truncated?: boolean;
  durationMs: number;
  success: boolean;
  errorCode?: string;
}

export interface AuditLogger {
  log(event: AuditEvent): void;
}
