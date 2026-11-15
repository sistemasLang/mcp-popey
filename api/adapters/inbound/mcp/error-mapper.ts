import type { InternalErrorLogger } from '../../../application/ports/outbound/internal-error-log.port.js';
import { AppError, InternalError, type SqlDiagnostics } from '../../../domain/errors.js';

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
export function toPublicError(error: unknown, logInternal: InternalErrorLogger): PublicError {
  if (error instanceof AppError && !(error instanceof InternalError)) {
    return error.diagnostics
      ? { code: error.code, message: error.message, diagnostics: error.diagnostics }
      : { code: error.code, message: error.message };
  }
  logInternal(error);
  return { code: 'INTERNAL_ERROR', message: 'An internal error occurred' };
}
