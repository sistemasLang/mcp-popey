import type { UserKind } from '../../../domain/user.js';

/**
 * One record per tool call. Never contains access tokens, passwords,
 * connection strings, SQL text or result rows.
 */
export interface AuditEvent {
  timestamp: string;
  userId: string;
  principalKind: UserKind;
  role: string;
  databaseKey: string;
  tool: string;
  circuit?: string;
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

export type AdminAction =
  | 'invite_user'
  | 'update_user'
  | 'disable_user'
  | 'enable_user'
  | 'issue_password_link'
  | 'create_service_account'
  | 'rotate_service_secret'
  | 'bootstrap_admin';

/**
 * One record per admin write (API or bootstrap). Only internal ids and field
 * names: never emails, IdP subjects, secrets, tokens or password links.
 */
export interface AdminAuditEvent {
  timestamp: string;
  /** Internal id of the admin, or "bootstrap". */
  actorUserId: string;
  action: AdminAction;
  targetUserId?: string;
  changedFields: string[];
  success: boolean;
  errorCode?: string;
}

export interface AuditLogger {
  log(event: AuditEvent): void;
  logAdmin(event: AdminAuditEvent): void;
}
