import type { UserContext } from '../auth/user-context.js';
import type { CircuitPolicyService } from '../circuits/circuit-policy.service.js';
import type { ResolvedTable } from '../circuits/circuit.types.js';
import { ColumnNotAllowedError, InvalidQueryError, TableNotAllowedError } from '../errors/app-errors.js';
import { isBlockedSchema } from '../security/blocked-schemas.js';
import type { QueryLimits } from '../security/query-limits.js';
import {
  FILTER_OPERATORS,
  type QueryCircuitRequest,
  type QueryFilter,
  type ScalarValue,
  type ValidatedFilter,
  type ValidatedQuery,
} from './query.types.js';

/**
 * Authorization-level validation of a structurally valid request. Any
 * problem rejects the whole query; nothing is ever "fixed" silently.
 */
export class QueryValidator {
  constructor(
    private readonly circuits: CircuitPolicyService,
    private readonly limits: QueryLimits,
  ) {}

  validate(user: UserContext, request: QueryCircuitRequest): ValidatedQuery {
    // 1-4. Circuit exists, user may access it, table belongs to it, table is queryable.
    const table = this.circuits.getQueryableTable(user, request.circuit, request.table);

    // 5-7. Explicit re-checks (already part of `queryable`; kept on purpose).
    if (table.status.includes('legacy')) throw new TableNotAllowedError(`Table "${table.qualifiedName}" is legacy`);
    if (table.status.includes('needs_review')) {
      throw new TableNotAllowedError(`Table "${table.qualifiedName}" needs review`);
    }
    if (isBlockedSchema(table.schema)) throw new TableNotAllowedError(`Schema "${table.schema}" is not allowed`);

    // 8-9. Selected columns.
    if (request.select.length > this.limits.maxSelectedColumns) {
      throw new InvalidQueryError(`At most ${this.limits.maxSelectedColumns} columns can be selected`);
    }
    if (new Set(request.select).size !== request.select.length) {
      throw new InvalidQueryError('Duplicated column in select');
    }
    const columns = request.select.map((column) => {
      if (!this.circuits.isColumnSelectable(table, column)) throw columnError(table, column, 'selected');
      return column;
    });

    // 10-11. Filters.
    const requestedFilters = request.filters ?? [];
    if (requestedFilters.length > this.limits.maxFilters) {
      throw new InvalidQueryError(`At most ${this.limits.maxFilters} filters are allowed`);
    }
    const filters = requestedFilters.map((filter) => this.validateFilter(table, filter));

    // 12-13. ORDER BY.
    const requestedOrder = request.orderBy ?? [];
    if (requestedOrder.length > this.limits.maxOrderBy) {
      throw new InvalidQueryError(`At most ${this.limits.maxOrderBy} orderBy entries are allowed`);
    }
    const orderBy = requestedOrder.map((order) => {
      if (!this.circuits.isColumnSortable(table, order.field)) throw columnError(table, order.field, 'sorted');
      if (order.direction !== 'asc' && order.direction !== 'desc') {
        throw new InvalidQueryError('orderBy direction must be "asc" or "desc"');
      }
      return { column: order.field, direction: order.direction === 'asc' ? ('ASC' as const) : ('DESC' as const) };
    });

    // 14. LIMIT.
    const limit = request.limit ?? this.limits.defaultRows;
    if (!Number.isInteger(limit) || limit < 1 || limit > this.limits.maxRows) {
      throw new InvalidQueryError(`limit must be an integer between 1 and ${this.limits.maxRows}`);
    }

    return { circuit: request.circuit, table, columns, filters, orderBy, limit };
  }

  private validateFilter(table: ResolvedTable, filter: QueryFilter): ValidatedFilter {
    const column = filter.field;
    if (!this.circuits.isColumnFilterable(table, column)) throw columnError(table, column, 'filtered');
    if (!(FILTER_OPERATORS as readonly string[]).includes(filter.operator)) {
      throw new InvalidQueryError(`Operator "${String(filter.operator)}" is not allowed`);
    }

    switch (filter.operator) {
      case 'isNull':
      case 'isNotNull':
        if (filter.value !== undefined) {
          throw new InvalidQueryError(`Operator "${filter.operator}" does not take a value (field "${column}")`);
        }
        return { column, operator: filter.operator };

      case 'in': {
        const values = filter.value;
        if (!Array.isArray(values) || values.length === 0) {
          throw new InvalidQueryError(`Operator "in" requires a non-empty array (field "${column}")`);
        }
        if (values.length > this.limits.maxInValues) {
          throw new InvalidQueryError(`Operator "in" accepts at most ${this.limits.maxInValues} values`);
        }
        return { column, operator: 'in', value: values.map((value) => this.scalar(value, column)) };
      }

      case 'contains':
      case 'startsWith': {
        const value = this.scalar(filter.value, column);
        if (typeof value !== 'string' || value.length === 0) {
          throw new InvalidQueryError(`Operator "${filter.operator}" requires a non-empty string (field "${column}")`);
        }
        return { column, operator: filter.operator, value };
      }

      default:
        return { column, operator: filter.operator, value: this.scalar(filter.value, column) };
    }
  }

  private scalar(value: unknown, column: string): ScalarValue {
    if (typeof value === 'string') {
      if (value.length > this.limits.maxValueLength) {
        throw new InvalidQueryError(`Value for "${column}" exceeds ${this.limits.maxValueLength} characters`);
      }
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'boolean') return value;
    throw new InvalidQueryError(`Invalid value for "${column}": expected string, number or boolean`);
  }
}

function columnError(table: ResolvedTable, column: string, action: string): ColumnNotAllowedError {
  const isPending = table.pendingColumns.some((pending) => pending.column === column);
  const detail = isPending ? 'it is documented as pending (not implemented)' : 'it is not an allowed column';
  return new ColumnNotAllowedError(
    `Column "${column}" cannot be ${action} on "${table.qualifiedName}": ${detail}`,
  );
}
