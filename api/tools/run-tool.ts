import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ToolEvent } from '../audit.js';
import type { User } from '../auth.js';
import { toPublicError } from '../errors.js';
import type { App } from '../http.js';

/** What every tool receives: the authenticated caller (server-side) and the app's services. */
export interface ToolContext {
  user: User;
  app: App;
}

type AuditDetails = Pick<ToolEvent, 'circuit' | 'sqlSha256' | 'sqlLength' | 'rowCount' | 'truncated'>;

/**
 * Shared by the three tools: runs the handler, writes one audit line (success or
 * failure) and turns any error into a safe MCP error result.
 */
export async function runTool<T>(
  tool: string,
  { user, app }: ToolContext,
  run: () => Promise<T> | T,
  details: { before?: AuditDetails; after?: (result: T) => AuditDetails } = {},
): Promise<CallToolResult> {
  const startedAt = performance.now();
  const event = {
    userId: user.id,
    principalKind: user.kind,
    role: user.role,
    databaseKey: user.databaseKey,
    tool,
    ...details.before,
  };
  const finish = (extra: Partial<ToolEvent> & { success: boolean }) =>
    app.audit({
      timestamp: new Date().toISOString(),
      ...event,
      ...extra,
      durationMs: Math.round(performance.now() - startedAt),
    });

  try {
    const result = await run();
    finish({ ...details.after?.(result), success: true });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    const publicError = toPublicError(error);
    finish({ success: false, errorCode: publicError.code });
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: publicError }) }] };
  }
}
