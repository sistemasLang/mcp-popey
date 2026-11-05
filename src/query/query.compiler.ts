import { IDENTIFIER_PATTERN } from '../circuits/circuit.schema.js';
import { InternalError } from '../errors/app-errors.js';
import type { CompiledQuery, ValidatedFilter, ValidatedQuery } from './query.types.js';

const COMPARISON_SQL = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const;

/**
 * ValidatedQuery → parameterized SQL. The only place in the application that
 * writes SQL text. Values always travel as $n parameters; identifiers come
 * from CircuitRegistry and are re-checked here before being quoted.
 */
export class QueryCompiler {
  compile(query: ValidatedQuery): CompiledQuery {
    const params: unknown[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    const lines = [
      `SELECT ${query.columns.map(quoteIdentifier).join(', ')}`,
      `FROM ${quoteIdentifier(query.table.schema)}.${quoteIdentifier(query.table.name)}`,
    ];

    if (query.filters.length > 0) {
      lines.push(`WHERE ${query.filters.map((filter) => compileFilter(filter, bind)).join(' AND ')}`);
    }

    if (query.orderBy.length > 0) {
      const terms = query.orderBy.map(({ column, direction }) => {
        if (direction !== 'ASC' && direction !== 'DESC') throw new InternalError('Invalid sort direction');
        return `${quoteIdentifier(column)} ${direction}`;
      });
      lines.push(`ORDER BY ${terms.join(', ')}`);
    }

    if (!Number.isInteger(query.limit) || query.limit < 1) throw new InternalError('Invalid limit');
    lines.push(`LIMIT ${bind(query.limit)}`);

    return { sql: lines.join('\n'), params };
  }
}

function compileFilter(filter: ValidatedFilter, bind: (value: unknown) => string): string {
  const column = quoteIdentifier(filter.column);
  switch (filter.operator) {
    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return `${column} ${COMPARISON_SQL[filter.operator]} ${bind(filter.value)}`;
    case 'in':
      return `${column} = ANY(${bind(filter.value)})`;
    case 'contains':
      return `${column}::text ILIKE ${bind(`%${escapeLike(filter.value)}%`)} ESCAPE '\\'`;
    case 'startsWith':
      return `${column}::text ILIKE ${bind(`${escapeLike(filter.value)}%`)} ESCAPE '\\'`;
    case 'isNull':
      return `${column} IS NULL`;
    case 'isNotNull':
      return `${column} IS NOT NULL`;
    default: {
      const unreachable: never = filter;
      throw new InternalError(`Unsupported operator: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Last line of defense: refuses anything that is not a plain lowercase identifier. */
export function quoteIdentifier(identifier: string): string {
  if (!IDENTIFIER_PATTERN.test(identifier)) throw new InternalError('Refusing to compile an unsafe identifier');
  return `"${identifier}"`;
}

/** Makes %, _ and \ literal inside a LIKE pattern (used with ESCAPE '\'). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
