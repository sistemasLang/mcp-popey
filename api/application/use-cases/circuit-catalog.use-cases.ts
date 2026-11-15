import type {
  CircuitDescription,
  CircuitPolicyService,
  CircuitSummary,
} from '../services/circuit-policy.service.js';
import type { UserContext } from '../../domain/user-context.js';

/** list_circuits: the circuits the user's role may access. */
export class ListCircuitsUseCase {
  constructor(private readonly circuits: CircuitPolicyService) {}

  execute(user: UserContext): { circuits: CircuitSummary[] } {
    return { circuits: this.circuits.getAvailableCircuits(user) };
  }
}

/** describe_circuit: tables, queryability and allowed columns of one circuit. */
export class DescribeCircuitUseCase {
  constructor(private readonly circuits: CircuitPolicyService) {}

  execute(user: UserContext, circuitId: string): CircuitDescription {
    return this.circuits.describeCircuit(user, circuitId);
  }
}
