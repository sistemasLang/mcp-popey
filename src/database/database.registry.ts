import { z } from 'zod';
import { ConfigurationError } from '../errors/app-errors.js';
import type { DatabaseConfig } from './database.types.js';

export const DATABASE_KEY_PATTERN = /^[a-z0-9_]{1,32}$/;

const DatabaseEnvSchema = z.object({
  HOST: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  NAME: z.string().min(1),
  USER: z.string().min(1),
  PASSWORD: z.string().min(1),
  SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

/**
 * databaseKey → DatabaseConfig. The key always comes from UserContext
 * (server-side), never from an MCP request.
 *
 * Source today: env vars. `DATABASE_KEYS=lang,cliente_b` plus, per key,
 * DB_<KEY>_HOST / _PORT / _NAME / _USER / _PASSWORD / _SSL. Moving to a
 * secret manager only means building this registry from another source.
 */
export class DatabaseRegistry {
  private constructor(private readonly databases: ReadonlyMap<string, DatabaseConfig>) {}

  static fromConfigs(configs: Record<string, DatabaseConfig>): DatabaseRegistry {
    for (const key of Object.keys(configs)) assertValidKey(key);
    return new DatabaseRegistry(new Map(Object.entries(configs)));
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): DatabaseRegistry {
    const keys = (env.DATABASE_KEYS ?? '')
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key.length > 0);

    const databases = new Map<string, DatabaseConfig>();
    for (const key of keys) {
      assertValidKey(key);
      const prefix = `DB_${key.toUpperCase()}_`;
      const result = DatabaseEnvSchema.safeParse({
        HOST: env[`${prefix}HOST`],
        PORT: env[`${prefix}PORT`],
        NAME: env[`${prefix}NAME`],
        USER: env[`${prefix}USER`],
        PASSWORD: env[`${prefix}PASSWORD`],
        SSL: env[`${prefix}SSL`],
      });
      if (!result.success) {
        const missing = result.error.issues.map((issue) => `${prefix}${String(issue.path[0])}`);
        throw new ConfigurationError(`Incomplete database configuration for "${key}": ${missing.join(', ')}`);
      }
      const { HOST, PORT, NAME, USER, PASSWORD, SSL } = result.data;
      databases.set(key, { host: HOST, port: PORT, database: NAME, user: USER, password: PASSWORD, ssl: SSL });
    }
    return new DatabaseRegistry(databases);
  }

  has(databaseKey: string): boolean {
    return this.databases.has(databaseKey);
  }

  keys(): string[] {
    return [...this.databases.keys()];
  }

  get(databaseKey: string): DatabaseConfig {
    const config = this.databases.get(databaseKey);
    // The message never echoes connection details.
    if (!config) throw new ConfigurationError('No database is configured for this user');
    return config;
  }
}

function assertValidKey(key: string): void {
  if (!DATABASE_KEY_PATTERN.test(key)) {
    throw new ConfigurationError(`Invalid database key "${key}": use 1-32 chars [a-z0-9_]`);
  }
}
