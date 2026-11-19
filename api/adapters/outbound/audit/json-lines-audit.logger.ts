import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AdminAuditEvent, AuditEvent, AuditLogger } from '../../../application/ports/outbound/audit-log.port.js';

/** JSON Lines to a file, or to stderr when no file is configured. Tool and admin events share the sink. */
export class JsonLinesAuditLogger implements AuditLogger {
  constructor(private readonly filePath?: string) {
    if (filePath) mkdirSync(dirname(filePath), { recursive: true });
  }

  log(event: AuditEvent): void {
    this.write({ type: 'audit', ...event });
  }

  logAdmin(event: AdminAuditEvent): void {
    this.write({ type: 'admin', ...event });
  }

  private write(record: object): void {
    const line = `${JSON.stringify(record)}\n`;
    try {
      if (this.filePath) appendFileSync(this.filePath, line, { encoding: 'utf8', mode: 0o600 });
      else process.stderr.write(line);
    } catch {
      process.stderr.write(line);
    }
  }
}
