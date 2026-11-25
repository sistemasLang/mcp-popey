/**
 * Errors that can reach an MCP client. `message` is always safe to show: no SQL,
 * no stack, no credentials. Anything else that is thrown becomes INTERNAL_ERROR.
 */

/** PostgreSQL's own diagnosis of a statement written by the AI, so it can fix its SQL. */
export interface SqlDiagnostics {
  sqlState: string;
  message: string;
  hint?: string;
  position?: number;
}

export type ErrorCode =
  | 'AUTHORIZATION_ERROR'
  | 'CIRCUIT_NOT_FOUND'
  | 'INVALID_QUERY'
  | 'DATABASE_QUERY_ERROR'
  | 'QUERY_TIMEOUT'
  | 'RATE_LIMIT_EXCEEDED';

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly diagnostics?: SqlDiagnostics,
  ) {
    super(message);
  }
}

/** A broken .env or YAML file: the server refuses to start. */
export class ConfigError extends Error {}

export interface PublicError {
  code: string;
  message: string;
  diagnostics?: SqlDiagnostics;
}

/** Any thrown value → what the client sees. Unknown errors are logged and replaced by a generic one. */
export function toPublicError(error: unknown): PublicError {
  if (error instanceof AppError) {
    return error.diagnostics
      ? { code: error.code, message: error.message, diagnostics: error.diagnostics }
      : { code: error.code, message: error.message };
  }
  logInternalError(error);
  return { code: 'INTERNAL_ERROR', message: 'An internal error occurred' };
}

/** Internal diagnostics go to stderr (pm2 error log), never to the client. */
export function logInternalError(error: unknown): void {
  const detail = redactCredentials(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.stderr.write(`${JSON.stringify({ type: 'internal_error', timestamp: new Date().toISOString(), detail })}\n`);
}

/** `postgres://user:secret@host` → `postgres://user:***@host`. */
export function redactCredentials(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^@\s]+@/gi, '$1***@');
}
