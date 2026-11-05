import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { CIRCUIT_ID_PATTERN } from '../circuits/circuit.schema.js';
import type { CircuitRegistry } from '../circuits/circuit.registry.js';
import { ConfigurationError } from '../errors/app-errors.js';
import type { RolePolicy } from './role-policy.types.js';

export const ROLE_PATTERN = /^[a-z0-9_]{1,64}$/;

const CircuitAccessFileSchema = z
  .object({
    roles: z
      .record(
        z.string().regex(ROLE_PATTERN, 'role must be lowercase snake_case'),
        z
          .object({
            circuits: z.array(z.string().regex(CIRCUIT_ID_PATTERN)).default([]),
            /** Grants query_sql (free read-only SQL). A business decision, like circuits. */
            sql: z.boolean().default(false),
          })
          .strict(),
      )
      .nullish()
      .transform((roles) => roles ?? {}),
  })
  .strict();

/**
 * circuit-access.yaml → RolePolicy. Fails startup if a role references a
 * circuit that circuits.yaml does not define (a typo must not silently
 * become "no access" or, worse, be ignored).
 */
export class RolePolicyLoader {
  static loadFile(path: string, registry: CircuitRegistry): RolePolicy {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      throw new ConfigurationError(`Cannot read circuit access file: ${path}`, { cause: error });
    }
    return RolePolicyLoader.parse(text, registry, path);
  }

  static parse(text: string, registry: CircuitRegistry, origin = 'circuit-access.yaml'): RolePolicy {
    let document: unknown;
    try {
      document = parse(text);
    } catch (error) {
      throw new ConfigurationError(`Invalid YAML in ${origin}`, { cause: error });
    }

    const result = CircuitAccessFileSchema.safeParse(document);
    if (!result.success) {
      throw new ConfigurationError(`Invalid circuit access definition in ${origin}:\n${z.prettifyError(result.error)}`);
    }

    const roles = new Map<string, ReadonlySet<string>>();
    const sqlRoles = new Set<string>();
    for (const [role, { circuits, sql }] of Object.entries(result.data.roles)) {
      const unknown = circuits.filter((circuit) => !registry.has(circuit));
      if (unknown.length > 0) {
        throw new ConfigurationError(`Role "${role}" in ${origin} references unknown circuits: ${unknown.join(', ')}`);
      }
      roles.set(role, new Set(circuits));
      if (sql) sqlRoles.add(role);
    }
    return { roles, sqlRoles, canUseSql: (role: string) => sqlRoles.has(role) };
  }
}
