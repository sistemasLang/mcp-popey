import type { ResolvedTable } from '../circuits/circuit.types.js';

export const FILTER_OPERATORS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'contains',
  'startsWith',
  'isNull',
  'isNotNull',
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export type ScalarValue = string | number | boolean;

export interface QueryFilter {
  field: string;
  operator: FilterOperator;
  value?: unknown;
}

export interface QueryOrder {
  field: string;
  direction: 'asc' | 'desc';
}

/** What an MCP client may control. Nothing about databases, schemas or SQL. */
export interface QueryCircuitRequest {
  circuit: string;
  table: string;
  select: string[];
  filters?: QueryFilter[];
  orderBy?: QueryOrder[];
  limit?: number;
}

export type ValidatedFilter =
  | { column: string; operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'; value: ScalarValue }
  | { column: string; operator: 'contains' | 'startsWith'; value: string }
  | { column: string; operator: 'in'; value: ScalarValue[] }
  | { column: string; operator: 'isNull' | 'isNotNull' };

/**
 * Output of QueryValidator, the only input QueryCompiler accepts. Every
 * identifier in it was taken from CircuitRegistry, not from the request.
 */
export interface ValidatedQuery {
  circuit: string;
  table: ResolvedTable;
  columns: string[];
  filters: ValidatedFilter[];
  orderBy: Array<{ column: string; direction: 'ASC' | 'DESC' }>;
  limit: number;
}

export interface CompiledQuery {
  sql: string;
  params: unknown[];
}
