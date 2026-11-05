import { McpServer } from '@modelcontextprotocol/server';
import type { AuditLogger } from '../audit/audit.logger.js';
import type { UserContext } from '../auth/user-context.js';
import type { CircuitPolicyService } from '../circuits/circuit-policy.service.js';
import type { RolePolicy } from '../permissions/role-policy.types.js';
import type { QueryExecutor } from '../query/query.executor.js';
import type { QueryValidator } from '../query/query.validator.js';
import type { SqlQueryLimits } from '../security/query-limits.js';
import type { RateLimiter } from '../security/rate-limiter.js';
import type { SqlExecutor } from '../sql/sql.executor.js';
import { registerDescribeCircuitTool } from './tools/describe-circuit.tool.js';
import { registerListCircuitsTool } from './tools/list-circuits.tool.js';
import { registerQueryCircuitTool } from './tools/query-circuit.tool.js';
import { registerQuerySqlTool } from './tools/query-sql.tool.js';

export interface ToolDependencies {
  circuits: CircuitPolicyService;
  validator: QueryValidator;
  executor: QueryExecutor;
  rateLimiter: RateLimiter;
  audit: AuditLogger;
  rolePolicy: RolePolicy;
  sqlExecutor: SqlExecutor;
  sqlQueryLimits: SqlQueryLimits;
}

/**
 * One MCP server per authenticated request. The UserContext is bound here,
 * server-side, so no tool can take the user, role or database from its input.
 * query_sql (free read-only SQL) is registered only for roles with `sql: true`:
 * other users do not even see it in tools/list. No tool writes data.
 */
export function createMcpServer(user: UserContext, deps: ToolDependencies): McpServer {
  const server = new McpServer({ name: 'mcp-popey', version: '1.0.0' });
  registerListCircuitsTool(server, user, deps);
  registerDescribeCircuitTool(server, user, deps);
  registerQueryCircuitTool(server, user, deps);
  if (deps.rolePolicy.canUseSql(user.role)) registerQuerySqlTool(server, user, deps);
  return server;
}
