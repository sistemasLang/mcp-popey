/**
 * Application errors. Every error that can reach an MCP client is one of
 * these: `message` is always safe to show (no SQL, no stack, no credentials,
 * no raw PostgreSQL text). Anything else is mapped to InternalError.
 */
/**
 * PostgreSQL's own diagnosis of a statement written by the model (query_sql),
 * so it can fix its SQL. Never set for connection or socket errors.
 */
export interface SqlDiagnostics {
  sqlState: string;
  message: string;
  hint?: string;
  position?: number;
}

export abstract class AppError extends Error {
  abstract readonly code: string;
  readonly diagnostics?: SqlDiagnostics;

  constructor(message: string, options?: { cause?: unknown; diagnostics?: SqlDiagnostics }) {
    super(message, options);
    this.name = new.target.name;
    if (options?.diagnostics) this.diagnostics = options.diagnostics;
  }
}

export class AuthenticationError extends AppError {
  readonly code = 'AUTHENTICATION_ERROR';
}

export class AuthorizationError extends AppError {
  readonly code = 'AUTHORIZATION_ERROR';
}

export class CircuitNotFoundError extends AppError {
  readonly code = 'CIRCUIT_NOT_FOUND';
}

export class InvalidQueryError extends AppError {
  readonly code = 'INVALID_QUERY';
}

export class DatabaseQueryError extends AppError {
  readonly code = 'DATABASE_QUERY_ERROR';
}

export class QueryTimeoutError extends AppError {
  readonly code = 'QUERY_TIMEOUT';
}

export class RateLimitExceededError extends AppError {
  readonly code = 'RATE_LIMIT_EXCEEDED';
}

export class ConfigurationError extends AppError {
  readonly code = 'CONFIGURATION_ERROR';
}

export class InternalError extends AppError {
  readonly code = 'INTERNAL_ERROR';
}

/** Valid token, but the identity has no access (unknown, disabled, no role, not admin). Always "Forbidden". */
export class ForbiddenError extends AppError {
  readonly code = 'FORBIDDEN';
}

/** Invalid user-administration input (HTTP 400). Subclasses narrow it to 404 / 409. */
export class UserManagementError extends AppError {
  readonly code: string = 'USER_MANAGEMENT_ERROR';
}

export class UserNotFoundError extends UserManagementError {
  override readonly code: string = 'USER_NOT_FOUND';
}

export type UserConflictCode = 'DUPLICATE_USER' | 'DUPLICATE_IDENTITY' | 'LAST_ADMIN' | 'USER_DISABLED';

/** The request is valid but clashes with the current state (HTTP 409). */
export class UserConflictError extends UserManagementError {
  override readonly code: UserConflictCode;

  constructor(code: UserConflictCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** The identity provider rejected or failed a call. Never carries its response body or credentials. */
export class IdentityProviderError extends AppError {
  readonly code = 'IDENTITY_PROVIDER_ERROR';
}
