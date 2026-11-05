import { z } from 'zod';
import { FILTER_OPERATORS } from './query.types.js';

/**
 * Structural validation of MCP tool input. Authorization is a separate step
 * (QueryValidator). Objects are strict: an extra property such as
 * `databaseKey`, `sql` or `schema` is rejected, not silently dropped.
 *
 * Bounds here are hard caps against oversized payloads; the configurable
 * business limits are enforced by QueryValidator.
 */
const NameSchema = z.string().min(1).max(128);

const ScalarValueSchema = z.union([z.string().max(10_000), z.number().finite(), z.boolean()]);

export const FilterSchema = z
  .object({
    field: NameSchema.describe('Column name, as listed by describe_circuit'),
    operator: z.enum(FILTER_OPERATORS),
    value: z
      .union([ScalarValueSchema, z.array(ScalarValueSchema).max(1_000)])
      .optional()
      .describe('Omit for isNull/isNotNull; an array for "in"; a scalar otherwise'),
  })
  .strict();

export const OrderSchema = z
  .object({
    field: NameSchema,
    direction: z.enum(['asc', 'desc']),
  })
  .strict();

export const QueryCircuitSchema = z
  .object({
    circuit: NameSchema.describe('Circuit id from list_circuits'),
    table: NameSchema.describe('Qualified table name from describe_circuit, e.g. "stock.factura_venta"'),
    select: z.array(NameSchema).min(1).max(200).describe('Columns to return'),
    filters: z.array(FilterSchema).max(200).optional().describe('Combined with AND'),
    orderBy: z.array(OrderSchema).max(50).optional(),
    limit: z.number().int().positive().optional().describe('Maximum rows to return'),
  })
  .strict();

export const DescribeCircuitSchema = z
  .object({
    circuit: NameSchema.describe('Circuit id from list_circuits'),
  })
  .strict();

export const ListCircuitsSchema = z.object({}).strict();
