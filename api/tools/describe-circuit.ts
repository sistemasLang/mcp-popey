import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { circuitFor } from '../circuits.js';
import { runTool, type ToolContext } from './run-tool.js';

/** describe_circuit: tables of one circuit, what each stores and its confirmed columns. */
export function registerDescribeCircuit(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'describe_circuit',
    {
      title: 'Describe circuit',
      description:
        'Describes a circuit: its tables, what each one stores and its confirmed columns. Use it as business ' +
        'context to write SQL for query_sql. queryable=false marks tables documented as legacy, under review ' +
        'or without confirmed columns: prefer the others.',
      // Strict: an extra property (databaseKey, schema...) is an error, not silently dropped.
      inputSchema: z.object({ circuit: z.string().min(1).max(128).describe('Circuit id from list_circuits') }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ circuit }) =>
      runTool('describe_circuit', ctx, () => circuitFor(ctx.app.catalog, ctx.user.role, circuit), {
        before: { circuit },
      }),
  );
}
