/**
 * Raw shapes, as written in circuits.yaml (after structural validation and
 * camelCase mapping). They are documentation: nothing here is trusted as a
 * SQL identifier until CircuitRegistry resolves it.
 */
export interface CircuitDefinition {
  id: string;
  description: string;
  docs?: string[];
  namingNote?: string;
  tables: CircuitTable[];
  pendingColumns?: PendingColumn[];
}

export interface CircuitTable {
  table: string;
  role: string;
  keyColumns: string[];
  source?: string;
  status?: string[];
  notes?: string;
}

export interface PendingColumn {
  table: string;
  column: string;
  status: string;
  description?: string;
}

/** Why a table cannot be queried. Deny by default: any reason blocks it. */
export type TableDenyReason =
  | 'needs_review'
  | 'legacy'
  | 'unknown_status'
  | 'blocked_schema'
  | 'no_confirmed_columns';

/**
 * A table as the rest of the application sees it: identifiers validated,
 * documentary key_columns filtered out, pending columns removed and the
 * static (user-independent) queryability decided once at startup.
 */
export interface ResolvedTable {
  /** Exactly as written in circuits.yaml, e.g. "stock.factura_venta". */
  qualifiedName: string;
  schema: string;
  name: string;
  description: string;
  status: string[];
  notes?: string;
  source?: string;
  /** Real column names that may be selected, filtered and sorted. */
  columns: readonly string[];
  /** key_columns entries that are prose, not column names. */
  unconfirmedColumnNotes: readonly string[];
  /** Columns documented as pending for this table; never queryable. */
  pendingColumns: readonly PendingColumn[];
  queryable: boolean;
  denyReasons: readonly TableDenyReason[];
}

export interface ResolvedCircuit {
  id: string;
  description: string;
  docs: readonly string[];
  namingNote?: string;
  /** Keyed by qualifiedName. */
  tables: ReadonlyMap<string, ResolvedTable>;
  pendingColumns: readonly PendingColumn[];
}
