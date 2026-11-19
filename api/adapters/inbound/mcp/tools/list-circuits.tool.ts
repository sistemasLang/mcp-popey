import type { McpServer } from '@modelcontextprotocol/server';
import type { Principal } from '../../../../domain/user-context.js';
import type { McpUseCases } from '../mcp-server.js';
import { ListCircuitsSchema } from '../schemas/circuit-catalog.schema.js';
import { runTool } from '../tool-runner.js';

export function registerListCircuitsTool(server: McpServer, principal: Principal, deps: McpUseCases): void {
  const user = principal.context;
  server.registerTool(
    'list_circuits',
    {
      title: 'List circuits',
      description:
        'Lists the Popey ERP business circuits (venta, compras, ...) available to the current user. ' +
        'Start here, then call describe_circuit and query the data with query_sql.',
      inputSchema: ListCircuitsSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      runTool('list_circuits', principal, deps, {
        run: () => deps.listCircuits.execute(user),
      }),
  );
}
