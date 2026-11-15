/**
 * Schemas that are never queryable, whatever circuits.yaml or
 * circuit-access.yaml say. Deliberately empty today: `seguridad` is enabled on
 * purpose for the `usuario` circuit (resolving user id -> name/role). Its
 * sensitive columns (passwords, recovery hashes, 2FA codes, birth date) are
 * protected twice instead: they are never listed in circuits.yaml key_columns,
 * and the mcp_popey_ro role only has column-level SELECT grants on the safe ones.
 * The '' entry keeps the mechanism (and its checks) active without blocking
 * any real schema.
 */
export const BLOCKED_SCHEMAS: readonly string[] = [''];

export function isBlockedSchema(schema: string): boolean {
  return BLOCKED_SCHEMAS.includes(schema.toLowerCase());
}
