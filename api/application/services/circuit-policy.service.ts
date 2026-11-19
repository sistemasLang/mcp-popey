import type { UserContext } from '../../domain/user-context.js';
import { AuthorizationError, CircuitNotFoundError } from '../../domain/errors.js';
import type { AuthorizationService } from './authorization.service.js';
import type { CircuitRegistry } from '../../domain/circuits/circuit.registry.js';
import type { PendingColumn, ResolvedCircuit, ResolvedTable, TableDenyReason } from '../../domain/circuits/circuit.types.js';

export interface CircuitSummary {
  id: string;
  description: string;
}

export interface TableDescription {
  table: string;
  description: string;
  queryable: boolean;
  columns?: string[];
  status?: string[];
  notQueryableReasons?: TableDenyReason[];
  pendingColumns?: Array<Pick<PendingColumn, 'column' | 'status' | 'description'>>;
  notes?: string;
}

export interface CircuitDescription {
  id: string;
  description: string;
  namingNote?: string;
  tables: TableDescription[];
}

/**
 * Single place for the rules about which circuits a user may see. Tools call
 * this; they never inspect circuits.yaml themselves.
 */
export class CircuitPolicyService {
  constructor(
    private readonly registry: CircuitRegistry,
    private readonly authorization: AuthorizationService,
  ) {}

  getAvailableCircuits(user: UserContext): CircuitSummary[] {
    return this.registry
      .list()
      .filter((circuit) => this.authorization.canAccessCircuit(user, circuit.id))
      .map((circuit) => ({ id: circuit.id, description: circuit.description }));
  }

  describeCircuit(user: UserContext, circuitId: string): CircuitDescription {
    const circuit = this.getAccessibleCircuit(user, circuitId);
    return {
      id: circuit.id,
      description: circuit.description,
      namingNote: circuit.namingNote,
      tables: [...circuit.tables.values()].map((table) => describeTable(table)),
    };
  }

  getAccessibleCircuit(user: UserContext, circuitId: string): ResolvedCircuit {
    const circuit = this.registry.get(circuitId);
    if (!circuit) throw new CircuitNotFoundError(`Circuit "${circuitId}" does not exist`);
    if (!this.authorization.canAccessCircuit(user, circuitId)) {
      throw new AuthorizationError(`Access to circuit "${circuitId}" is not allowed for this user`);
    }
    return circuit;
  }
}

function describeTable(table: ResolvedTable): TableDescription {
  const pendingColumns =
    table.pendingColumns.length > 0
      ? table.pendingColumns.map(({ column, status, description }) => ({ column, status, description }))
      : undefined;

  if (!table.queryable) {
    return {
      table: table.qualifiedName,
      description: table.description,
      queryable: false,
      status: table.status.length > 0 ? table.status : undefined,
      notQueryableReasons: [...table.denyReasons],
      pendingColumns,
    };
  }

  return {
    table: table.qualifiedName,
    description: table.description,
    queryable: true,
    columns: [...table.columns],
    pendingColumns,
    notes: table.notes,
  };
}
