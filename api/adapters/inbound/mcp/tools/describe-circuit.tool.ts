import type { McpServer } from '@modelcontextprotocol/server';
import type { Principal } from '../../../../domain/user-context.js';
import type { McpUseCases } from '../mcp-server.js';
import { DescribeCircuitSchema } from '../schemas/circuit-catalog.schema.js';
import { runTool } from '../tool-runner.js';

export function registerDescribeCircuitTool(server: McpServer, principal: Principal, deps: McpUseCases): void {
  const user = principal.context;
  server.registerTool(
    'describe_circuit',
    {
      title: 'Describe circuit',
      description:
        'Describes a circuit: its tables, what each one stores and its confirmed columns. Use it as business ' +
        'context to write SQL for query_sql. queryable=false marks tables documented as legacy, under review ' +
        'or without confirmed columns: prefer the others.',
      inputSchema: DescribeCircuitSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ circuit }) =>
      runTool('describe_circuit', principal, deps, {
        audit: { circuit },
        run: () => deps.describeCircuit.execute(user, circuit),
      }),
  );
}
