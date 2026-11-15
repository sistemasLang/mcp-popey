/**
 * An MCP user. `databaseKey` only names a database configuration; it never
 * carries host, port, database name, password or connection string.
 */
export interface User {
  id: string;
  username: string;
  role: string;
  databaseKey: string;
  enabled: boolean;
}

/** Persisted form: the user plus the SHA-256 of their bearer token. */
export interface UserRecord extends User {
  tokenSha256: string;
  createdAt: string;
}

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/** Drops the credential fields of a persisted record. */
export function toUser(record: UserRecord): User {
  return {
    id: record.id,
    username: record.username,
    role: record.role,
    databaseKey: record.databaseKey,
    enabled: record.enabled,
  };
}
