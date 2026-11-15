import type { McpServer } from '@modelcontextprotocol/server';
import type { UserContext } from '../../../../domain/user-context.js';
import type { McpUseCases } from '../mcp-server.js';
import { QueryCircuitSchema } from '../schemas/query-circuit.schema.js';
import { runTool } from '../tool-runner.js';

/** Tool → Zod (SDK) → UserContext (closure) → QueryCircuitUseCase. */
export function registerQueryCircuitTool(server: McpServer, user: UserContext, deps: McpUseCases): void {
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
      runTool('query_circuit', user, deps, {
        audit: {
          circuit: request.circuit,
          table: request.table,
          columns: request.select,
          filterFields: request.filters?.map((filter) => filter.field),
        },
        run: () => deps.queryCircuit.execute(user, request),
        auditResult: (result) => ({ rowCount: result.rowCount }),
      }),
  );
}
