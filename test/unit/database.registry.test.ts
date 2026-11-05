import { describe, expect, it } from 'vitest';
import { DatabaseRegistry } from '../../src/database/database.registry.js';
import { ConfigurationError } from '../../src/errors/app-errors.js';

const env = {
  DATABASE_KEYS: 'lang, cliente_b',
  DB_LANG_HOST: 'db-lang',
  DB_LANG_NAME: 'langdb',
  DB_LANG_USER: 'mcp_popey_ro',
  DB_LANG_PASSWORD: 'secret-lang',
  DB_CLIENTE_B_HOST: 'db-b',
  DB_CLIENTE_B_PORT: '6543',
  DB_CLIENTE_B_NAME: 'bdb',
  DB_CLIENTE_B_USER: 'mcp_popey_ro',
  DB_CLIENTE_B_PASSWORD: 'secret-b',
  DB_CLIENTE_B_SSL: 'true',
};

describe('DatabaseRegistry', () => {
  it('builds one config per declared key', () => {
    const registry = DatabaseRegistry.fromEnv(env);
    expect(registry.keys()).toEqual(['lang', 'cliente_b']);
    expect(registry.get('lang')).toEqual({
      host: 'db-lang',
      port: 5432,
      database: 'langdb',
      user: 'mcp_popey_ro',
      password: 'secret-lang',
      ssl: false,
    });
    expect(registry.get('cliente_b')).toMatchObject({ port: 6543, ssl: true });
  });

  it('unknown key → error that does not leak other configs', () => {
    const registry = DatabaseRegistry.fromEnv(env);
    expect(() => registry.get('cliente_c')).toThrow(ConfigurationError);
    try {
      registry.get('cliente_c');
    } catch (error) {
      expect(String((error as Error).message)).not.toMatch(/secret|db-lang|langdb/);
    }
  });

  it('variables of an undeclared key are ignored', () => {
    expect(DatabaseRegistry.fromEnv({ DB_X_HOST: 'h', DB_X_NAME: 'n', DB_X_USER: 'u', DB_X_PASSWORD: 'p' }).has('x')).toBe(false);
  });

  it('refuses incomplete configuration, naming missing variables but not values', () => {
    expect(() => DatabaseRegistry.fromEnv({ DATABASE_KEYS: 'lang', DB_LANG_HOST: 'h' })).toThrow(/DB_LANG_NAME/);
  });

  it.each(['Lang', 'a-b', '../x', 'a b', ''.padEnd(33, 'a')])('refuses invalid key "%s"', (key) => {
    expect(() => DatabaseRegistry.fromConfigs({ [key]: env as never })).toThrow(ConfigurationError);
  });
});
