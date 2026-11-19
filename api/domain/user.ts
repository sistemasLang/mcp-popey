import { UserConflictError, UserManagementError } from './errors.js';

export type UserKind = 'human' | 'service';

/** A login at an external identity provider: the stable `(iss, sub)` pair of its tokens. */
export interface ExternalIdentity {
  readonly issuer: string;
  readonly subject: string;
}

/**
 * A user of this server. Identity (who) comes from the IdP; authorization
 * (role, databaseKey, admin, enabled) lives only here. `databaseKey` only
 * names a database configuration, never connection data. `label` is for
 * display and lookups by admins, never for authorization.
 */
export interface User {
  id: string;
  kind: UserKind;
  label: string;
  admin: boolean;
  enabled: boolean;
  /** `role` and `databaseKey` go together; without them the user has no /mcp access. */
  role?: string;
  databaseKey?: string;
  identities: ExternalIdentity[];
  createdAt: string;
}

export type UserWithMcpAccess = User & { role: string; databaseKey: string };

export const SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function hasMcpAccess(user: User): user is UserWithMcpAccess {
  return user.role !== undefined && user.databaseKey !== undefined;
}

export function sameIdentity(a: ExternalIdentity, b: ExternalIdentity): boolean {
  return a.issuer === b.issuer && a.subject === b.subject;
}

/** Lower-cases and checks an email address used to invite a person. */
export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new UserManagementError('email must be a valid email address');
  }
  return email;
}

/** Domain rules of a single user. Throws UserManagementError. */
export function assertValidUser(user: User): void {
  if ((user.role === undefined) !== (user.databaseKey === undefined)) {
    throw new UserManagementError('role and databaseKey must be set together or not at all');
  }
  if (user.kind === 'service' && user.admin) {
    throw new UserManagementError('a service account cannot be an admin');
  }
  if (user.identities.length === 0) {
    throw new UserManagementError('a user needs at least one identity');
  }
}

/** An `(issuer, subject)` pair belongs to one user only. Throws UserConflictError. */
export function assertUniqueIdentities(users: readonly User[]): void {
  const seen = new Map<string, string>();
  for (const user of users) {
    for (const identity of user.identities) {
      const key = JSON.stringify([identity.issuer, identity.subject]);
      const owner = seen.get(key);
      if (owner !== undefined && owner !== user.id) {
        throw new UserConflictError('DUPLICATE_IDENTITY', 'identity is already linked to another user');
      }
      seen.set(key, user.id);
    }
  }
}

/** Admin view of a user: no raw identities. */
export interface UserView {
  id: string;
  kind: UserKind;
  label: string;
  admin: boolean;
  role: string | null;
  databaseKey: string | null;
  enabled: boolean;
  createdAt: string;
}

export function toUserView(user: User): UserView {
  return {
    id: user.id,
    kind: user.kind,
    label: user.label,
    admin: user.admin,
    role: user.role ?? null,
    databaseKey: user.databaseKey ?? null,
    enabled: user.enabled,
    createdAt: user.createdAt,
  };
}
