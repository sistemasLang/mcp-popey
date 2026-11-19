import type { AdminAuditEvent, AuditEvent, AuditLogger } from '../../../application/ports/outbound/audit-log.port.js';

export class InMemoryAuditLogger implements AuditLogger {
  readonly events: AuditEvent[] = [];
  readonly adminEvents: AdminAuditEvent[] = [];

  log(event: AuditEvent): void {
    this.events.push(event);
  }

  logAdmin(event: AdminAuditEvent): void {
    this.adminEvents.push(event);
  }
}
