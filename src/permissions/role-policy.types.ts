/** role → circuits it may access. A role not listed here has no access. */
export interface RolePolicy {
  readonly roles: ReadonlyMap<string, ReadonlySet<string>>;
  /** Roles with `sql: true`: they may use query_sql. Deny by default. */
  readonly sqlRoles: ReadonlySet<string>;
  canUseSql(role: string): boolean;
}
