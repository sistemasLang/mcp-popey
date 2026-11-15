import { z } from 'zod';

/**
 * Input of query_sql. Strict: `databaseKey`, `params`, `schema`, `role`... are
 * rejected, not dropped. The SQL itself is never parsed nor rewritten:
 * PostgreSQL enforces read-only (role grants, READ ONLY transaction, one statement).
 */
export const QuerySqlSchema = z
  .object({
    sql: z
      .string()
      .min(1)
      .max(100_000)
      .describe('One read-only SQL statement (SELECT, WITH, EXPLAIN...). No parameters: write literals inline.'),
  })
  .strict();

export type QuerySqlRequest = z.infer<typeof QuerySqlSchema>;
