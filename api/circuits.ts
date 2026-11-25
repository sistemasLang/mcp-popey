import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { AppError, ConfigError } from './errors.js';

/**
 * The business catalog the AI reads before writing SQL:
 *   - config/circuits.yaml         what each circuit is and which tables/columns it uses.
 *   - config/circuit-access.yaml   which roles exist and which circuits each one sees.
 *
 * The catalog is documentation, not a permission: query_sql does not consult it.
 * What a role can read is decided by the grants of mcp_popey_ro in PostgreSQL.
 * Both files are read once at startup; a structural error stops the server.
 */

const NAME = /^[a-z0-9_]{1,64}$/;
const COLUMN = /^[a-z_][a-z0-9_]{0,62}$/;
const TABLE = /^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}$/;

const oneOrMany = z.union([z.string().min(1), z.array(z.string().min(1))]).transform((v) => (Array.isArray(v) ? v : [v]));

const CircuitsFileSchema = z
  .object({
    circuits: z.record(
      z.string().regex(NAME, 'circuit id must be lowercase snake_case'),
      z
        .object({
          description: z.string().min(1),
          docs: z.array(z.string()).optional(),
          naming_note: z.string().optional(),
          tables: z
            .array(
              z
                .object({
                  table: z.string().regex(TABLE, 'table must be "schema.table" in lowercase snake_case'),
                  role: z.string().min(1),
                  // May contain prose such as "columnas no confirmadas": it is filtered out below, not a boot error.
                  key_columns: z.array(z.string()).nullish(),
                  source: z.string().optional(),
                  status: oneOrMany.optional(),
                  notes: z.string().optional(),
                })
                .strict(),
            )
            .min(1),
          pending_columns: z
            .array(
              z
                .object({
                  table: z.string().regex(TABLE),
                  column: z.string().min(1),
                  status: z.string().min(1),
                  description: z.string().optional(),
                  source: z.string().optional(),
                })
                .strict(),
            )
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();

const AccessFileSchema = z
  .object({
    roles: z
      .record(
        z.string().regex(NAME, 'role must be lowercase snake_case'),
        z.object({ circuits: z.array(z.string().regex(NAME)).default([]) }).strict(),
      )
      .nullish(),
  })
  .strict();

interface PendingColumn {
  column: string;
  status: string;
  description?: string;
}

/** A table as describe_circuit returns it. */
export interface TableDescription {
  table: string;
  description: string;
  /** false: documented as legacy / under review / without confirmed columns. Prefer the others. */
  queryable: boolean;
  columns?: string[];
  status?: string[];
  notQueryableReasons?: string[];
  pendingColumns?: PendingColumn[];
  notes?: string;
}

export interface Circuit {
  id: string;
  description: string;
  namingNote?: string;
  tables: TableDescription[];
}

export interface Catalog {
  circuits: Map<string, Circuit>;
  /** role → circuits it sees. A role not listed here has no access to the server at all. */
  roles: Map<string, Set<string>>;
}

export function loadCatalog(circuitsFile: string, accessFile: string): Catalog {
  return parseCatalog(readFileSync(circuitsFile, 'utf8'), readFileSync(accessFile, 'utf8'));
}

export function parseCatalog(circuitsYaml: string, accessYaml: string): Catalog {
  const circuitsFile = validate(CircuitsFileSchema, circuitsYaml, 'circuits.yaml');
  const accessFile = validate(AccessFileSchema, accessYaml, 'circuit-access.yaml');

  const circuits = new Map<string, Circuit>();
  for (const [id, raw] of Object.entries(circuitsFile.circuits)) {
    // The same table may be listed several times in one circuit (e.g. to document a trigger): merge them.
    const entriesByTable = new Map<string, RawTable[]>();
    for (const entry of raw.tables) entriesByTable.set(entry.table, [...(entriesByTable.get(entry.table) ?? []), entry]);
    const tables = [...entriesByTable].map(([table, entries]) =>
      describeTable(table, entries, (raw.pending_columns ?? []).filter((pending) => pending.table === table)),
    );
    circuits.set(id, { id, description: raw.description, namingNote: raw.naming_note?.trim(), tables });
  }

  const roles = new Map<string, Set<string>>();
  for (const [role, { circuits: visible }] of Object.entries(accessFile.roles ?? {})) {
    // A typo must not silently become "no access".
    const unknown = visible.filter((circuit) => !circuits.has(circuit));
    if (unknown.length > 0) throw new ConfigError(`Role "${role}" in circuit-access.yaml references unknown circuits: ${unknown.join(', ')}`);
    roles.set(role, new Set(visible));
  }
  return { circuits, roles };
}

type RawTable = z.infer<typeof CircuitsFileSchema>['circuits'][string]['tables'][number];
type RawPending = NonNullable<z.infer<typeof CircuitsFileSchema>['circuits'][string]['pending_columns']>[number];

function describeTable(table: string, entries: RawTable[], pending: RawPending[]): TableDescription {
  const pendingNames = new Set(pending.map((p) => p.column));
  // Only real identifiers that are not pending count as columns; prose and "..." are dropped.
  const columns = [...new Set(entries.flatMap((entry) => entry.key_columns ?? []))].filter(
    (column) => COLUMN.test(column) && !pendingNames.has(column),
  );
  const status = [...new Set(entries.flatMap((entry) => entry.status ?? []))];

  // Deny by default: any status other than these known two also marks the table.
  const reasons: string[] = [...new Set(status.map((s) => (s === 'needs_review' || s === 'legacy' ? s : 'unknown_status')))];
  if (columns.length === 0) reasons.push('no_confirmed_columns');

  const description = entries.map((entry) => entry.role).join(' | ');
  const notes = entries.flatMap((entry) => entry.notes ?? []).join(' | ') || undefined;
  const pendingColumns = pending.length > 0 ? pending.map(({ column, status, description }) => ({ column, status, description })) : undefined;

  if (reasons.length > 0) {
    return { table, description, queryable: false, status: status.length > 0 ? status : undefined, notQueryableReasons: reasons, pendingColumns };
  }
  return { table, description, queryable: true, columns, pendingColumns, notes };
}

function validate<T>(schema: z.ZodType<T>, text: string, origin: string): T {
  let document: unknown;
  try {
    document = parse(text);
  } catch {
    throw new ConfigError(`Invalid YAML in ${origin}`);
  }
  const result = schema.safeParse(document);
  if (!result.success) throw new ConfigError(`Invalid ${origin}:\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** One circuit, or an error if it does not exist or the role does not see it. */
export function circuitFor(catalog: Catalog, role: string, circuitId: string): Circuit {
  const circuit = catalog.circuits.get(circuitId);
  if (!circuit) throw new AppError('CIRCUIT_NOT_FOUND', `Circuit "${circuitId}" does not exist`);
  if (!catalog.roles.get(role)?.has(circuitId)) {
    throw new AppError('AUTHORIZATION_ERROR', `Access to circuit "${circuitId}" is not allowed for this user`);
  }
  return circuit;
}
