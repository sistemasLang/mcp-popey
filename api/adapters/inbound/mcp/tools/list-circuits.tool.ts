import type { McpServer } from '@modelcontextprotocol/server';
import type { UserContext } from '../../../../domain/user-context.js';
import type { McpUseCases } from '../mcp-server.js';
import { ListCircuitsSchema } from '../schemas/query-circuit.schema.js';
import { runTool } from '../tool-runner.js';

export function registerListCircuitsTool(server: McpServer, user: UserContext, deps: McpUseCases): void {
  server.registerTool(
    'list_circuits',
    {
      title: 'List circuits',
      description:
        'Lists the Popey ERP business circuits (venta, compras, ...) available to the current user. ' +
        'Start here, then call describe_circuit.',
      inputSchema: ListCircuitsSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      runTool('list_circuits', user, deps, {
        run: () => deps.listCircuits.execute(user),
      }),
  );
}
