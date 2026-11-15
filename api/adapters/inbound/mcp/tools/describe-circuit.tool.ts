import type { McpServer } from '@modelcontextprotocol/server';
import type { UserContext } from '../../../../domain/user-context.js';
import type { McpUseCases } from '../mcp-server.js';
import { DescribeCircuitSchema } from '../schemas/query-circuit.schema.js';
import { runTool } from '../tool-runner.js';

export function registerDescribeCircuitTool(server: McpServer, user: UserContext, deps: McpUseCases): void {
  server.registerTool(
    'describe_circuit',
    {
      title: 'Describe circuit',
      description:
        'Describes a circuit: its tables, what each one stores, whether it can be queried and which ' +
        'columns are allowed. Only tables with queryable=true and their listed columns can be used in query_circuit.',
      inputSchema: DescribeCircuitSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ circuit }) =>
      runTool('describe_circuit', user, deps, {
        audit: { circuit },
        run: () => deps.describeCircuit.execute(user, circuit),
      }),
  );
}
