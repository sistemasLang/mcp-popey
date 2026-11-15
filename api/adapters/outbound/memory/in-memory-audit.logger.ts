import type { AuditEvent, AuditLogger } from '../../../application/ports/outbound/audit-log.port.js';

export class InMemoryAuditLogger implements AuditLogger {
  readonly events: AuditEvent[] = [];

  log(event: AuditEvent): void {
    this.events.push(event);
  }
}
