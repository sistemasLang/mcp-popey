import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { ConfigurationError } from '../errors/app-errors.js';
import { CircuitsFileSchema } from './circuit.schema.js';
import type { CircuitDefinition } from './circuit.types.js';

/**
 * circuits.yaml → parse → structural validation → CircuitDefinition[].
 * Runs once at startup; tools never read the file.
 */
export class CircuitLoader {
  static loadFile(path: string): CircuitDefinition[] {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      throw new ConfigurationError(`Cannot read circuits file: ${path}`, { cause: error });
    }
    return CircuitLoader.parse(text, path);
  }

  static parse(text: string, origin = 'circuits.yaml'): CircuitDefinition[] {
    let document: unknown;
    try {
      document = parse(text);
    } catch (error) {
      throw new ConfigurationError(`Invalid YAML in ${origin}`, { cause: error });
    }

    const result = CircuitsFileSchema.safeParse(document);
    if (!result.success) {
      throw new ConfigurationError(
        `Invalid circuits definition in ${origin}:\n${z.prettifyError(result.error)}`,
      );
    }

    return Object.entries(result.data.circuits).map(([id, raw]) => ({
      id,
      description: raw.description,
      docs: raw.docs,
      namingNote: raw.naming_note?.trim(),
      tables: raw.tables.map((table) => ({
        table: table.table,
        role: table.role,
        keyColumns: table.key_columns ?? [],
        source: table.source,
        status: table.status,
        notes: table.notes,
      })),
      pendingColumns: raw.pending_columns?.map((pending) => ({
        table: pending.table,
        column: pending.column,
        status: pending.status,
        description: pending.description,
      })),
    }));
  }
}
