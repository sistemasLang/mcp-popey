import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../api', import.meta.url));

function filesIn(layer: string): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
    });
  return walk(join(SRC, layer));
}

function importsOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1] ?? '');
}

function violations(layer: string, forbidden: RegExp): string[] {
  return filesIn(layer).flatMap((file) =>
    importsOf(file)
      .filter((specifier) => forbidden.test(specifier))
      .map((specifier) => `${relative(SRC, file)} → ${specifier}`),
  );
}

/** Hexagonal dependency rule: dependencies only point inward. */
describe('architecture', () => {
  it('domain depends on nothing outside itself (Node built-ins aside)', () => {
    expect(violations('domain', /(application|adapters|composition|config)\/|^(?!node:|\.)/)).toEqual([]);
  });

  it('application depends only on domain and its own ports', () => {
    expect(violations('application', /(adapters|composition|config)\/|^(?!node:|\.)/)).toEqual([]);
  });

  it('adapters never reach into the composition root', () => {
    expect(violations('adapters', /composition\//)).toEqual([]);
  });

  it('domain and application know nothing about jose or Auth0: changing IdP is an adapter swap', () => {
    for (const layer of ['domain', 'application']) {
      expect(violations(layer, /^jose$|\/auth0\//)).toEqual([]);
      for (const file of filesIn(layer)) expect(readFileSync(file, 'utf8')).not.toMatch(/auth0\.com|@clients/);
    }
  });

  it('only the JWT verifier imports jose, and only the Auth0 adapter talks to Auth0', () => {
    const importers = (pattern: RegExp) =>
      ['domain', 'application', 'adapters', 'composition', 'config']
        .flatMap((layer) => filesIn(layer))
        .filter((file) => importsOf(file).some((specifier) => pattern.test(specifier)))
        .map((file) => relative(SRC, file));
    expect(importers(/^jose$/)).toEqual(['adapters/inbound/http/jwt-access-token.verifier.ts']);
    expect(importers(/auth0-identity-provider\.adapter\.js$/)).toEqual(['composition/bootstrap.ts']);
  });
});
