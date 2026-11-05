import type { User } from '../users/user.model.js';

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

export function createUserContext(user: User): UserContext {
  return Object.freeze({
    userId: user.id,
    role: user.role,
    databaseKey: user.databaseKey,
  });
}
