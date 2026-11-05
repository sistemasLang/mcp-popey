import type { UserContext } from '../auth/user-context.js';
import type { CircuitRegistry } from '../circuits/circuit.registry.js';
import { isBlockedSchema } from '../security/blocked-schemas.js';
import type { RolePolicy } from './role-policy.types.js';

/** user + role + circuit-access.yaml + circuits.yaml → yes/no. */
export class AuthorizationService {
  constructor(
    private readonly rolePolicy: RolePolicy,
    private readonly registry: CircuitRegistry,
  ) {}

  canAccessCircuit(user: UserContext, circuit: string): boolean {
    if (!this.registry.has(circuit)) return false;
    return this.rolePolicy.roles.get(user.role)?.has(circuit) ?? false;
  }

  canQueryTable(user: UserContext, circuit: string, table: string): boolean {
    if (!this.canAccessCircuit(user, circuit)) return false;
    const resolved = this.registry.getTable(circuit, table);
    if (!resolved) return false;
    // Blocked schemas are already folded into `queryable`; checked again on purpose.
    return resolved.queryable && !isBlockedSchema(resolved.schema);
  }

  /** query_sql is opt-in per role; circuit grants do not imply it. */
  canUseSql(user: UserContext): boolean {
    return this.rolePolicy.canUseSql(user.role);
  }

  isKnownRole(role: string): boolean {
    return this.rolePolicy.roles.has(role);
  }
}
