import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { runTool, type ToolContext } from './run-tool.js';

/** list_circuits: the ERP business circuits (venta, compras, ...) the caller's role sees. */
export function registerListCircuits(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_circuits',
    {
      title: 'List circuits',
      description:
        'Lists the Popey ERP business circuits (venta, compras, ...) available to the current user. ' +
        'Start here, then call describe_circuit and query the data with query_sql.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      runTool('list_circuits', ctx, () => {
        const visible = ctx.app.catalog.roles.get(ctx.user.role) ?? new Set();
        const circuits = [...ctx.app.catalog.circuits.values()]
          .filter((circuit) => visible.has(circuit.id))
          .map(({ id, description }) => ({ id, description }));
        return { circuits };
      }),
  );
}
