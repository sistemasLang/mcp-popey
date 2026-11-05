import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import type { UserContext } from '../../auth/user-context.js';
import { QuerySqlSchema } from '../../sql/sql.schema.js';
import type { ToolDependencies } from '../server.js';
import { runTool } from '../tool-runner.js';

const DESCRIPTION = [
  'Runs ONE read-only SQL statement on your company database (PostgreSQL) and returns its rows.',
  'Any read is allowed: SELECT, WITH, JOIN, GROUP BY, window functions, EXPLAIN, information_schema, pg_catalog.',
  'Writes and DDL always fail. Several statements in one call are rejected.',
  'Use list_circuits / describe_circuit for what each table means in the business,',
  'and information_schema.columns for the exact columns.',
  'In the seguridad schema list the columns explicitly: SELECT * is denied there (sensitive columns are not readable).',
  'Dates are returned as "YYYY-MM-DD".',
  'At most {maxRows} rows are returned; if "truncated" is true there were more:',
  'aggregate in SQL (count, sum, group by) or page with LIMIT/OFFSET.',
  'On error, "diagnostics" carries PostgreSQL\'s message, hint and position to fix the SQL.',
].join(' ');

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Tool → Zod (SDK) → UserContext (closure) → RateLimiter → SqlExecutor → DatabaseAdapter.
 * Registered only for roles with `sql: true` (see createMcpServer).
 */
export function registerQuerySqlTool(server: McpServer, user: UserContext, deps: ToolDependencies): void {
  server.registerTool(
    'query_sql',
    {
      title: 'Query SQL (read-only)',
      description: DESCRIPTION.replace('{maxRows}', String(deps.sqlQueryLimits.maxRows)),
      inputSchema: QuerySqlSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ sql }) =>
      runTool('query_sql', user, deps.audit, {
        // Hash and length only: literals in the SQL may carry personal data.
        audit: { sqlSha256: sha256(sql), sqlLength: sql.length },
        run: async () => {
          deps.rateLimiter.consume(user.userId);
          return deps.sqlExecutor.execute(user, sql);
        },
        auditResult: (result) => ({ rowCount: result.rowCount, truncated: result.truncated }),
      }),
  );
}
