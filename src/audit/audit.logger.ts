import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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

/** JSON Lines to a file, or to stderr when no file is configured. */
export class JsonLinesAuditLogger implements AuditLogger {
  constructor(private readonly filePath?: string) {
    if (filePath) mkdirSync(dirname(filePath), { recursive: true });
  }

  log(event: AuditEvent): void {
    const line = `${JSON.stringify({ type: 'audit', ...event })}\n`;
    try {
      if (this.filePath) appendFileSync(this.filePath, line, { encoding: 'utf8', mode: 0o600 });
      else process.stderr.write(line);
    } catch {
      process.stderr.write(line);
    }
  }
}

export class InMemoryAuditLogger implements AuditLogger {
  readonly events: AuditEvent[] = [];

  log(event: AuditEvent): void {
    this.events.push(event);
  }
}
