import type { McpServer } from '@modelcontextprotocol/server';
import type { UserContext } from '../../auth/user-context.js';
import { QueryCircuitSchema } from '../../query/query.schema.js';
import type { ToolDependencies } from '../server.js';
import { runTool } from '../tool-runner.js';

/**
 * Tool → Zod (SDK) → UserContext (closure) → RateLimiter → QueryValidator
 * (Authorization + CircuitPolicy) → QueryExecutor → DatabaseAdapter.
 */
export function registerQueryCircuitTool(server: McpServer, user: UserContext, deps: ToolDependencies): void {
  server.registerTool(
    'query_circuit',
    {
      title: 'Query circuit',
      description:
        'Reads rows from one table of a circuit. Use only tables marked queryable=true and columns listed by ' +
        'describe_circuit. Filters are combined with AND. Operators: eq, neq, gt, gte, lt, lte, in (array value), ' +
        'contains / startsWith (case-insensitive text), isNull / isNotNull (no value). Dates as "YYYY-MM-DD".',
      inputSchema: QueryCircuitSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (request) =>
      runTool('query_circuit', user, deps.audit, {
        audit: {
          circuit: request.circuit,
          table: request.table,
          columns: request.select,
          filterFields: request.filters?.map((filter) => filter.field),
        },
        run: async () => {
          deps.rateLimiter.consume(user.userId);
          const validated = deps.validator.validate(user, request);
          return deps.executor.execute(user, validated);
        },
        auditResult: (result) => ({ rowCount: result.rowCount }),
      }),
  );
}
