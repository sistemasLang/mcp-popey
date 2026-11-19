/** role → circuits it may see in the catalog. A role not listed here has no access. */
export interface RolePolicy {
  readonly roles: ReadonlyMap<string, ReadonlySet<string>>;
}
