import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { runTool, type ToolContext } from './run-tool.js';

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

/**
 * query_sql: free read-only SQL on the caller's tenant database.
 * The database is ALWAYS ctx.user.databaseKey (from users.yaml); the input has no way to choose it.
 * Read-only is enforced by PostgreSQL (see db.ts), not by inspecting the SQL.
 */
export function registerQuerySql(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'query_sql',
    {
      title: 'Query SQL (read-only)',
      description: DESCRIPTION.replace('{maxRows}', String(ctx.app.maxRows)),
      // Strict: `databaseKey`, `params`, `schema`... are rejected, not dropped.
      inputSchema: z
        .object({
          sql: z
            .string()
            .min(1)
            .max(100_000)
            .describe('One read-only SQL statement (SELECT, WITH, EXPLAIN...). No parameters: write literals inline.'),
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ sql }) =>
      runTool(
        'query_sql',
        ctx,
        () => {
          ctx.app.rateLimit(ctx.user.id);
          return ctx.app.runSql(ctx.user.databaseKey, sql);
        },
        {
          // Hash and length only: literals in the SQL may carry personal data.
          before: { sqlSha256: createHash('sha256').update(sql, 'utf8').digest('hex'), sqlLength: sql.length },
          after: (result) => ({ rowCount: result.rowCount, truncated: result.truncated }),
        },
      ),
  );
}

/** Sliding window per user (not per IP), in memory: run a single instance (pm2 fork, instances: 1). */
export function createRateLimiter({ maxRequests, windowMs }: { maxRequests: number; windowMs: number }, now = Date.now) {
  const hits = new Map<string, number[]>();
  return (userId: string): void => {
    const time = now();
    const recent = (hits.get(userId) ?? []).filter((at) => at > time - windowMs);
    if (recent.length >= maxRequests) {
      hits.set(userId, recent);
      const retryIn = Math.ceil(((recent[0] ?? time) + windowMs - time) / 1000);
      throw new AppError('RATE_LIMIT_EXCEEDED', `Rate limit exceeded; retry in ${retryIn}s`);
    }
    recent.push(time);
    hits.set(userId, recent);
  };
}
