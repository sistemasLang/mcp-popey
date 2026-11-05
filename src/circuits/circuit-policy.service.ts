import type { UserContext } from '../auth/user-context.js';
import {
  AuthorizationError,
  CircuitNotFoundError,
  TableNotAllowedError,
} from '../errors/app-errors.js';
import type { AuthorizationService } from '../permissions/authorization.service.js';
import type { CircuitRegistry } from './circuit.registry.js';
import type { PendingColumn, ResolvedCircuit, ResolvedTable, TableDenyReason } from './circuit.types.js';

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
 * Single place for the rules about what a user may see and query inside a
 * circuit. Tools call this; they never inspect circuits.yaml themselves.
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

  getQueryableTable(user: UserContext, circuitId: string, tableName: string): ResolvedTable {
    const circuit = this.getAccessibleCircuit(user, circuitId);
    const table = circuit.tables.get(tableName);
    if (!table) {
      throw new TableNotAllowedError(`Table "${tableName}" does not belong to circuit "${circuitId}"`);
    }
    if (!this.authorization.canQueryTable(user, circuitId, tableName)) {
      throw new TableNotAllowedError(
        `Table "${tableName}" is not queryable (${table.denyReasons.join(', ') || 'denied'})`,
      );
    }
    return table;
  }

  isColumnSelectable(table: ResolvedTable, column: string): boolean {
    return isQueryableColumn(table, column);
  }

  isColumnFilterable(table: ResolvedTable, column: string): boolean {
    return isQueryableColumn(table, column);
  }

  isColumnSortable(table: ResolvedTable, column: string): boolean {
    return isQueryableColumn(table, column);
  }
}

/** MVP rule: only confirmed key_columns of a queryable table, never pending ones. */
function isQueryableColumn(table: ResolvedTable, column: string): boolean {
  if (!table.queryable) return false;
  if (table.pendingColumns.some((pending) => pending.column === column)) return false;
  return table.columns.includes(column);
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
