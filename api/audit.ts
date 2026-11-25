import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * One JSON line per tool call (`type: "audit"`) and per admin write (`type: "admin"`).
 * Never contains tokens, connection data, SQL text, result rows, emails, Auth0
 * subjects, secrets or password links: only internal ids, field names and outcomes.
 */
export interface ToolEvent {
  timestamp: string;
  userId: string;
  principalKind: 'human' | 'service';
  role: string;
  databaseKey: string;
  tool: string;
  circuit?: string;
  /** query_sql: SHA-256 and length of the SQL, never the text. */
  sqlSha256?: string;
  sqlLength?: number;
  rowCount?: number;
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

export interface AdminEvent {
  timestamp: string;
  /** Internal id of the admin, or "bootstrap". */
  actorUserId: string;
  action: AdminAction;
  targetUserId?: string;
  changedFields: string[];
  success: boolean;
  errorCode?: string;
}

export type Audit = (event: ToolEvent | AdminEvent) => void;

/** To AUDIT_LOG_FILE (mode 0600) or, without one, to stderr (pm2 error log). */
export function createAudit(filePath?: string): Audit {
  if (filePath) mkdirSync(dirname(filePath), { recursive: true });
  return (event) => {
    const line = `${JSON.stringify({ type: 'action' in event ? 'admin' : 'audit', ...event })}\n`;
    try {
      if (filePath) appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 });
      else process.stderr.write(line);
    } catch {
      process.stderr.write(line);
    }
  };
}
