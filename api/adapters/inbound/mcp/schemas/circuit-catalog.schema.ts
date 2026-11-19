import { z } from 'zod';

/**
 * Structural validation of the catalog tools' input. Objects are strict: an
 * extra property such as `databaseKey` or `schema` is rejected, not dropped.
 */
const NameSchema = z.string().min(1).max(128);

export const DescribeCircuitSchema = z
  .object({
    circuit: NameSchema.describe('Circuit id from list_circuits'),
  })
  .strict();

export const ListCircuitsSchema = z.object({}).strict();
