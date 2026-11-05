import { AppError, InternalError, type SqlDiagnostics } from './app-errors.js';

export interface PublicError {
  code: string;
  message: string;
  /** Only for query_sql statements rejected by PostgreSQL. */
  diagnostics?: SqlDiagnostics;
}

/**
 * Any thrown value → something safe to send to an MCP client. AppErrors carry
 * curated messages; everything else becomes a generic INTERNAL_ERROR (the
 * original is only reported through `logInternal`, never to the client).
 */
export function toPublicError(error: unknown, logInternal: (error: unknown) => void): PublicError {
  if (error instanceof AppError && !(error instanceof InternalError)) {
    return error.diagnostics
      ? { code: error.code, message: error.message, diagnostics: error.diagnostics }
      : { code: error.code, message: error.message };
  }
  logInternal(error);
  return { code: 'INTERNAL_ERROR', message: 'An internal error occurred' };
}

/** Internal diagnostics go to stderr, with credentials in URLs redacted. */
export function logInternalError(error: unknown): void {
  const detail = redactCredentials(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.stderr.write(`${JSON.stringify({ type: 'internal_error', timestamp: new Date().toISOString(), detail })}\n`);
}

export function redactCredentials(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^@\s]+@/gi, '$1***@');
}
