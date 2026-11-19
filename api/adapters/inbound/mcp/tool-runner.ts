import type { CallToolResult } from '@modelcontextprotocol/server';
import type { AuditEvent, AuditLogger } from '../../../application/ports/outbound/audit-log.port.js';
import type { InternalErrorLogger } from '../../../application/ports/outbound/internal-error-log.port.js';
import type { Principal } from '../../../domain/user-context.js';
import { toPublicError } from './error-mapper.js';

type AuditDetails = Pick<AuditEvent, 'circuit' | 'rowCount' | 'sqlSha256' | 'sqlLength' | 'truncated'>;

export interface ToolRun<T> {
  /** Request fields worth auditing; known before running. */
  audit?: AuditDetails;
  run: () => Promise<T> | T;
  /** Extra audit fields derived from the result (e.g. rowCount). */
  auditResult?: (result: T) => AuditDetails;
}

/**
 * Centralized tool execution: runs the handler, audits success and failure,
 * and turns any error into a controlled MCP error result.
 */
export async function runTool<T>(
  toolName: string,
  { context: user, kind }: Principal,
  ports: { audit: AuditLogger; logInternalError: InternalErrorLogger },
  { audit: details, run, auditResult }: ToolRun<T>,
): Promise<CallToolResult> {
  const startedAt = performance.now();
  const baseEvent = {
    userId: user.userId,
    principalKind: kind,
    role: user.role,
    databaseKey: user.databaseKey,
    tool: toolName,
    ...details,
  };

  try {
    const result = await run();
    ports.audit.log({
      timestamp: new Date().toISOString(),
      ...baseEvent,
      ...auditResult?.(result),
      durationMs: Math.round(performance.now() - startedAt),
      success: true,
    });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    const publicError = toPublicError(error, ports.logInternalError);
    ports.audit.log({
      timestamp: new Date().toISOString(),
      ...baseEvent,
      durationMs: Math.round(performance.now() - startedAt),
      success: false,
      errorCode: publicError.code,
    });
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: publicError }) }] };
  }
}
