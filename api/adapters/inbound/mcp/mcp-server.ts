import { McpServer } from '@modelcontextprotocol/server';
import type { AuditLogger } from '../../../application/ports/outbound/audit-log.port.js';
import type { InternalErrorLogger } from '../../../application/ports/outbound/internal-error-log.port.js';
import type { AuthorizationService } from '../../../application/services/authorization.service.js';
import type {
  DescribeCircuitUseCase,
  ListCircuitsUseCase,
} from '../../../application/use-cases/circuit-catalog.use-cases.js';
import type { QuerySqlUseCase } from '../../../application/use-cases/query-sql.use-case.js';
import type { Principal } from '../../../domain/user-context.js';
import { registerDescribeCircuitTool } from './tools/describe-circuit.tool.js';
import { registerListCircuitsTool } from './tools/list-circuits.tool.js';
import { registerQuerySqlTool } from './tools/query-sql.tool.js';

/** Everything the MCP adapter needs: use cases plus cross-cutting ports. */
export interface McpUseCases {
  listCircuits: ListCircuitsUseCase;
  describeCircuit: DescribeCircuitUseCase;
  querySql: QuerySqlUseCase;
  authorization: AuthorizationService;
  audit: AuditLogger;
  logInternalError: InternalErrorLogger;
}

/**
 * One MCP server per authenticated request. The UserContext is bound here,
 * server-side, so no tool can take the user, role or database from its input.
 * query_sql (free read-only SQL) is registered only for roles defined in
 * circuit-access.yaml: other users do not even see it in tools/list. No tool
 * writes data.
 */
export function createMcpServer(principal: Principal, deps: McpUseCases): McpServer {
  const server = new McpServer({ name: 'mcp-popey', version: '1.0.0' });
  registerListCircuitsTool(server, principal, deps);
  registerDescribeCircuitTool(server, principal, deps);
  if (deps.authorization.canUseSql(principal.context)) registerQuerySqlTool(server, principal, deps);
  return server;
}
