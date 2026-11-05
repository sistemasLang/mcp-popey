import { isBlockedSchema } from '../security/blocked-schemas.js';
import { IDENTIFIER_PATTERN } from './circuit.schema.js';
import type {
  CircuitDefinition,
  CircuitTable,
  PendingColumn,
  ResolvedCircuit,
  ResolvedTable,
  TableDenyReason,
} from './circuit.types.js';

/** Statuses circuits.yaml uses to mark a table as not trustworthy yet. */
const RESTRICTED_STATUSES: ReadonlyMap<string, TableDenyReason> = new Map([
  ['needs_review', 'needs_review'],
  ['legacy', 'legacy'],
]);

/**
 * In-memory, read-only view of circuits.yaml. Built once at startup; every
 * schema/table/column name that ever reaches SQL comes from here.
 */
export class CircuitRegistry {
  private readonly circuits: ReadonlyMap<string, ResolvedCircuit>;

  private constructor(circuits: Map<string, ResolvedCircuit>) {
    this.circuits = circuits;
  }

  static fromDefinitions(definitions: readonly CircuitDefinition[]): CircuitRegistry {
    const circuits = new Map<string, ResolvedCircuit>();
    for (const definition of definitions) {
      circuits.set(definition.id, resolveCircuit(definition));
    }
    return new CircuitRegistry(circuits);
  }

  get(circuitId: string): ResolvedCircuit | undefined {
    return this.circuits.get(circuitId);
  }

  has(circuitId: string): boolean {
    return this.circuits.has(circuitId);
  }

  ids(): string[] {
    return [...this.circuits.keys()];
  }

  list(): ResolvedCircuit[] {
    return [...this.circuits.values()];
  }

  getTable(circuitId: string, qualifiedName: string): ResolvedTable | undefined {
    return this.circuits.get(circuitId)?.tables.get(qualifiedName);
  }
}

function resolveCircuit(definition: CircuitDefinition): ResolvedCircuit {
  const pendingColumns = definition.pendingColumns ?? [];

  // The same table may be listed more than once in a circuit (e.g. stock.articulo
  // in importacion_articulos, documenting a trigger separately). Merge them.
  const entriesByTable = new Map<string, CircuitTable[]>();
  for (const entry of definition.tables) {
    const entries = entriesByTable.get(entry.table) ?? [];
    entries.push(entry);
    entriesByTable.set(entry.table, entries);
  }

  const tables = new Map<string, ResolvedTable>();
  for (const [qualifiedName, entries] of entriesByTable) {
    tables.set(qualifiedName, resolveTable(qualifiedName, entries, pendingColumns));
  }

  return {
    id: definition.id,
    description: definition.description,
    docs: definition.docs ?? [],
    namingNote: definition.namingNote,
    tables,
    pendingColumns,
  };
}

function resolveTable(
  qualifiedName: string,
  entries: readonly CircuitTable[],
  circuitPendingColumns: readonly PendingColumn[],
): ResolvedTable {
  const [schema = '', name = ''] = qualifiedName.split('.');

  const pendingColumns = circuitPendingColumns.filter((pending) => pending.table === qualifiedName);
  const pendingNames = new Set(pendingColumns.map((pending) => pending.column));

  const columns: string[] = [];
  const unconfirmedColumnNotes: string[] = [];
  const status: string[] = [];

  for (const entry of entries) {
    for (const keyColumn of entry.keyColumns) {
      if (!IDENTIFIER_PATTERN.test(keyColumn)) {
        unconfirmedColumnNotes.push(keyColumn);
      } else if (!pendingNames.has(keyColumn) && !columns.includes(keyColumn)) {
        columns.push(keyColumn);
      }
    }
    for (const value of entry.status ?? []) {
      if (!status.includes(value)) status.push(value);
    }
  }

  const denyReasons: TableDenyReason[] = [];
  for (const value of status) {
    const reason = RESTRICTED_STATUSES.get(value) ?? 'unknown_status';
    if (!denyReasons.includes(reason)) denyReasons.push(reason);
  }
  if (isBlockedSchema(schema)) denyReasons.push('blocked_schema');
  if (columns.length === 0) denyReasons.push('no_confirmed_columns');

  const notes = entries.map((entry) => entry.notes).filter((note): note is string => !!note);
  const sources = entries.map((entry) => entry.source).filter((source): source is string => !!source);

  return {
    qualifiedName,
    schema,
    name,
    description: entries.map((entry) => entry.role).join(' | '),
    status,
    notes: notes.length > 0 ? notes.join(' | ') : undefined,
    source: sources.length > 0 ? sources.join(' | ') : undefined,
    columns: Object.freeze(columns),
    unconfirmedColumnNotes: Object.freeze(unconfirmedColumnNotes),
    pendingColumns: Object.freeze(pendingColumns),
    queryable: denyReasons.length === 0,
    denyReasons: Object.freeze(denyReasons),
  };
}
