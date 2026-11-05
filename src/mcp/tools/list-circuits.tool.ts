import type { McpServer } from '@modelcontextprotocol/server';
import type { UserContext } from '../../auth/user-context.js';
import { ListCircuitsSchema } from '../../query/query.schema.js';
import type { ToolDependencies } from '../server.js';
import { runTool } from '../tool-runner.js';

export function registerListCircuitsTool(server: McpServer, user: UserContext, deps: ToolDependencies): void {
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
      runTool('list_circuits', user, deps.audit, {
        run: () => ({ circuits: deps.circuits.getAvailableCircuits(user) }),
      }),
  );
}
