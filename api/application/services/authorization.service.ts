import type { UserContext } from '../../domain/user-context.js';
import type { CircuitRegistry } from '../../domain/circuits/circuit.registry.js';
import type { RolePolicy } from '../../domain/role-policy.js';

/** user + role + circuit-access.yaml + circuits.yaml → yes/no. */
export class AuthorizationService {
  constructor(
    private readonly rolePolicy: RolePolicy,
    private readonly registry: CircuitRegistry,
  ) {}

  /** Which circuits list_circuits and describe_circuit show to the role. */
  canAccessCircuit(user: UserContext, circuit: string): boolean {
    if (!this.registry.has(circuit)) return false;
    return this.rolePolicy.roles.get(user.role)?.has(circuit) ?? false;
  }

  /**
   * query_sql: every role defined in circuit-access.yaml (deny by default for
   * any other). What it can read is decided by the grants of mcp_popey_ro.
   */
  canUseSql(user: UserContext): boolean {
    return this.isKnownRole(user.role);
  }

  isKnownRole(role: string): boolean {
    return this.rolePolicy.roles.has(role);
  }
}
