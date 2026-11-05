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
