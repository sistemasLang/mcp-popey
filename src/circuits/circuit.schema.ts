import { z } from 'zod';

/**
 * Structural validation of circuits.yaml. A failure here aborts startup.
 *
 * Deliberately lenient about *documentary* content: a key_columns entry such
 * as "columnas no confirmadas..." is a valid string here; deciding that it is
 * not a column name is CircuitRegistry's job, not a reason to refuse to boot.
 */
export const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
export const QUALIFIED_TABLE_PATTERN = /^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}$/;
export const CIRCUIT_ID_PATTERN = /^[a-z0-9_]{1,64}$/;

const StatusSchema = z
  .union([z.string().min(1), z.array(z.string().min(1))])
  .transform((value) => (Array.isArray(value) ? value : [value]));

const RawTableSchema = z
  .object({
    table: z
      .string()
      .regex(QUALIFIED_TABLE_PATTERN, 'table must be "schema.table" in lowercase snake_case'),
    role: z.string().min(1),
    key_columns: z.array(z.string()).nullish(),
    source: z.string().optional(),
    status: StatusSchema.optional(),
    notes: z.string().optional(),
  })
  .strict();

const RawPendingColumnSchema = z
  .object({
    table: z.string().regex(QUALIFIED_TABLE_PATTERN),
    column: z.string().min(1),
    status: z.string().min(1),
    description: z.string().optional(),
    source: z.string().optional(),
  })
  .strict();

const RawCircuitSchema = z
  .object({
    description: z.string().min(1),
    docs: z.array(z.string()).optional(),
    naming_note: z.string().optional(),
    tables: z.array(RawTableSchema).min(1),
    pending_columns: z.array(RawPendingColumnSchema).optional(),
  })
  .strict();

export const CircuitsFileSchema = z
  .object({
    circuits: z.record(
      z.string().regex(CIRCUIT_ID_PATTERN, 'circuit id must be lowercase snake_case'),
      RawCircuitSchema,
    ),
  })
  .strict();

export type CircuitsFile = z.infer<typeof CircuitsFileSchema>;
