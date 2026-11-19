import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JwtAccessTokenVerifier } from '../../api/adapters/inbound/http/jwt-access-token.verifier.js';
import { YamlUserRepository } from '../../api/adapters/outbound/yaml/yaml-user.repository.js';
import { AuthenticationError, ConfigurationError, ForbiddenError, UserConflictError, UserManagementError } from '../../api/domain/errors.js';
import { createUserContext } from '../../api/domain/user-context.js';
import { assertUniqueIdentities, assertValidUser, normalizeEmail, toUserView, type User } from '../../api/domain/user.js';
import { createLocalJWKSet } from 'jose';
import {
  adminToken,
  makeAdmin,
  makeUser,
  mcpToken,
  signJwt,
  TEST_ADMIN_AUDIENCE,
  TEST_ISSUER,
  TEST_JWKS,
  TEST_MCP_AUDIENCE,
  testTokenVerifier,
} from '../e2e-harness.js';

const juan = makeUser('juan', 'ventas', 'lang').user;

describe('User domain rules', () => {
  it('role and databaseKey go together', () => {
    expect(() => assertValidUser({ ...juan, databaseKey: undefined })).toThrow(UserManagementError);
    expect(() => assertValidUser({ ...juan, role: undefined })).toThrow(/together/);
    const { role: _role, databaseKey: _key, ...noAccess } = juan;
    expect(() => assertValidUser(noAccess)).not.toThrow();
  });

  it('a service account cannot be admin', () => {
    const service = makeUser('n8n', 'ventas', 'lang', true, 'service').user;
    expect(() => assertValidUser({ ...service, admin: true })).toThrow(/service account cannot be an admin/);
  });

  it('a user needs an identity, and an identity belongs to one user only', () => {
    expect(() => assertValidUser({ ...juan, identities: [] })).toThrow(UserManagementError);
    const clone: User = { ...makeUser('otro', 'ventas', 'lang').user, identities: juan.identities };
    expect(() => assertUniqueIdentities([juan, clone])).toThrow(UserConflictError);
    expect(() => assertUniqueIdentities([juan, { ...juan }])).not.toThrow();
  });

  it('normalizes emails and rejects invalid ones', () => {
    expect(normalizeEmail('  Juan@Empresa.COM ')).toBe('juan@empresa.com');
    for (const bad of ['juan', 'juan@', '@empresa.com', 'a b@c.com', `${'x'.repeat(250)}@a.com`]) {
      expect(() => normalizeEmail(bad)).toThrow(UserManagementError);
    }
  });

  it('createUserContext uses the internal id (never the subject) and needs role + databaseKey', () => {
    const context = createUserContext(juan);
    expect(context).toEqual({ userId: 'juan', role: 'ventas', databaseKey: 'lang' });
    expect(Object.isFrozen(context)).toBe(true);
    expect(JSON.stringify(context)).not.toContain('auth0|');
    expect(() => createUserContext(makeAdmin('ana').user)).toThrow(ForbiddenError);
  });

  it('the admin view has no identities', () => {
    expect(toUserView(juan)).not.toHaveProperty('identities');
    expect(JSON.stringify(toUserView(juan))).not.toContain('auth0|juan');
  });
});

describe('YamlUserRepository (users.yaml v2)', () => {
  const tempFile = () => join(mkdtempSync(join(tmpdir(), 'mcp-users-')), 'users.yaml');

  it('a missing file is an empty repository', async () => {
    const repository = new YamlUserRepository(tempFile());
    expect(await repository.list()).toEqual([]);
    expect(await repository.findByIdentity(TEST_ISSUER, 'auth0|juan')).toBeNull();
  });

  it('writes version 2 atomically with mode 0600 and reads it back by identity, id and label', async () => {
    const path = tempFile();
    const repository = new YamlUserRepository(path);
    await repository.save(juan);
    await repository.save(makeAdmin('ana').user);

    expect(statSync(path).mode & 0o777).toBe(0o600);
    const text = readFileSync(path, 'utf8');
    expect(text).toMatch(/^version: 2/);
    expect(text).not.toMatch(/token|secret|password/i);

    const fresh = new YamlUserRepository(path);
    expect(await fresh.findByIdentity(TEST_ISSUER, 'auth0|juan')).toEqual(juan);
    expect(await fresh.findById('ana')).toMatchObject({ admin: true });
    expect(await fresh.findByLabel('ana@empresa.com')).toMatchObject({ id: 'ana' });
    expect(await fresh.countEnabledAdmins()).toBe(1);
  });

  it('refuses to save an identity already linked to another user, leaving the file untouched', async () => {
    const path = tempFile();
    const repository = new YamlUserRepository(path);
    await repository.save(juan);
    const before = readFileSync(path, 'utf8');
    await expect(repository.save({ ...makeUser('otro', 'ventas', 'lang').user, identities: juan.identities })).rejects.toThrow(
      UserConflictError,
    );
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('re-reads the file when its mtime changes (manual edits or another process)', async () => {
    const path = tempFile();
    const writer = new YamlUserRepository(path);
    const reader = new YamlUserRepository(path);
    await writer.save(juan);
    expect((await reader.findById('juan'))?.enabled).toBe(true);

    writeFileSync(path, readFileSync(path, 'utf8').replace('enabled: true', 'enabled: false'));
    const future = new Date(Date.now() + 5_000);
    utimesSync(path, future, future);
    expect((await reader.findById('juan'))?.enabled).toBe(false);
  });

  it.each([
    ['v1 without version', 'users:\n  - id: a\n    username: juan\n    role: ventas\n    databaseKey: lang\n    enabled: true\n    tokenSha256: ' + 'a'.repeat(64) + '\n    createdAt: x\n'],
    ['tokenSha256 under version 2', 'version: 2\nusers:\n  - id: a\n    tokenSha256: x\n'],
  ])('refuses the old format (%s) with a message that says to move it', async (_case, content) => {
    const path = tempFile();
    writeFileSync(path, content);
    const repository = new YamlUserRepository(path);
    await expect(repository.list()).rejects.toThrow(ConfigurationError);
    await expect(repository.list()).rejects.toThrow(/old format.*Move it aside/);
  });

  it.each([
    ['unknown property', 'version: 2\nusers:\n  - id: a\n    kind: human\n    label: x\n    admin: false\n    enabled: true\n    identities: [{ issuer: i, subject: s }]\n    createdAt: x\n    password: p\n'],
    ['role without databaseKey', 'version: 2\nusers:\n  - id: a\n    kind: human\n    label: x\n    admin: false\n    role: ventas\n    enabled: true\n    identities: [{ issuer: i, subject: s }]\n    createdAt: x\n'],
    ['duplicate identity', 'version: 2\nusers:\n' + ['a', 'b'].map((id) => `  - id: ${id}\n    kind: human\n    label: ${id}\n    admin: false\n    enabled: true\n    identities: [{ issuer: i, subject: s }]\n    createdAt: x\n`).join('')],
  ])('an invalid v2 file (%s) is a ConfigurationError', async (_case, content) => {
    const path = tempFile();
    writeFileSync(path, content);
    chmodSync(path, 0o600);
    await expect(new YamlUserRepository(path).list()).rejects.toThrow(ConfigurationError);
  });

  it('returns copies: mutating a result does not change the repository', async () => {
    const repository = new YamlUserRepository(tempFile());
    await repository.save(juan);
    const copy = await repository.findById('juan');
    copy!.enabled = false;
    expect((await repository.findById('juan'))?.enabled).toBe(true);
  });
});

describe('JwtAccessTokenVerifier', () => {
  const verifier = testTokenVerifier();
  const now = () => Math.floor(Date.now() / 1000);

  it('accepts a valid RS256 token and returns only (issuer, subject)', async () => {
    await expect(verifier.verify(mcpToken('auth0|juan', { email: 'x@y.z', role: 'admin' }), 'mcp')).resolves.toEqual({
      issuer: TEST_ISSUER,
      subject: 'auth0|juan',
    });
    await expect(verifier.verify(adminToken('auth0|ana'), 'admin')).resolves.toEqual({ issuer: TEST_ISSUER, subject: 'auth0|ana' });
  });

  it('accepts a token inside the 30 s clock tolerance and an aud array containing the resource', async () => {
    await expect(verifier.verify(mcpToken('auth0|juan', { exp: now() - 10 }), 'mcp')).resolves.toBeDefined();
    await expect(
      verifier.verify(signJwt({ sub: 'auth0|juan', aud: [TEST_MCP_AUDIENCE, 'https://idp.test/userinfo'] }), 'mcp'),
    ).resolves.toBeDefined();
  });

  it.each([
    ['foreign signature', signJwt({ sub: 's', aud: TEST_MCP_AUDIENCE }, { key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey })],
    ['alg none', signJwt({ sub: 's', aud: TEST_MCP_AUDIENCE }, { alg: 'none' })],
    ['alg HS256', signJwt({ sub: 's', aud: TEST_MCP_AUDIENCE }, { alg: 'HS256' })],
    ['expired', mcpToken('s', { exp: now() - 60 })],
    ['not yet valid', mcpToken('s', { nbf: now() + 120 })],
    ['other issuer', mcpToken('s', { iss: 'https://other.test/' })],
    ['admin audience on /mcp', adminToken('s')],
    ['no sub', signJwt({ aud: TEST_MCP_AUDIENCE })],
    ['no exp', signJwt({ sub: 's', aud: TEST_MCP_AUDIENCE, exp: undefined })],
    ['garbage', "' OR 1=1 --"],
    ['opaque token of the old scheme', 'A'.repeat(43)],
  ])('rejects %s with AuthenticationError', async (_case, token) => {
    await expect(verifier.verify(token, 'mcp')).rejects.toThrow(AuthenticationError);
  });

  it('a MCP token is rejected by the admin surface', async () => {
    await expect(verifier.verify(mcpToken('s'), 'admin')).rejects.toThrow(AuthenticationError);
  });

  it('refuses to be configured with the same audience for both surfaces', () => {
    expect(
      () =>
        new JwtAccessTokenVerifier({
          issuer: TEST_ISSUER,
          audiences: { mcp: TEST_ADMIN_AUDIENCE, admin: TEST_ADMIN_AUDIENCE },
          keys: createLocalJWKSet(TEST_JWKS),
        }),
    ).toThrow(/different/);
  });
});
