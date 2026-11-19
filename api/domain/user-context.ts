import { ForbiddenError } from './errors.js';
import { hasMcpAccess, type User, type UserKind } from './user.js';

/**
 * Who is calling, built server-side only after authentication. Tools receive
 * it from the server, never from their input: `databaseKey` in particular is
 * never accepted from an MCP request.
 */
export interface UserContext {
  readonly userId: string;
  readonly role: string;
  readonly databaseKey: string;
}

/** An authenticated caller of /mcp: its UserContext plus what kind of principal it is (for audit). */
export interface Principal {
  readonly context: UserContext;
  readonly kind: UserKind;
}

/** Uses the internal id, never the IdP subject. Users without role + databaseKey get no context. */
export function createUserContext(user: User): UserContext {
  if (!hasMcpAccess(user)) throw new ForbiddenError('Forbidden');
  return Object.freeze({
    userId: user.id,
    role: user.role,
    databaseKey: user.databaseKey,
  });
}
