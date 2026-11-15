import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditEvent, AuditLogger } from '../../../application/ports/outbound/audit-log.port.js';

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
