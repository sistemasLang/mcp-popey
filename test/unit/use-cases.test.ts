import { describe, expect, it } from 'vitest';
import { FakeIdentityProvider } from '../../api/adapters/outbound/memory/fake-identity-provider.js';
import { InMemoryAuditLogger } from '../../api/adapters/outbound/memory/in-memory-audit.logger.js';
import { InMemoryUserRepository } from '../../api/adapters/outbound/memory/in-memory-user.repository.js';
import { SlidingWindowRateLimiter } from '../../api/adapters/outbound/memory/sliding-window.rate-limiter.js';
import { RolePolicyLoader } from '../../api/adapters/outbound/yaml/role-policy.loader.js';
import { AuthorizationService } from '../../api/application/services/authorization.service.js';
import { AdminUsersUseCase } from '../../api/application/use-cases/admin-users.use-case.js';
import { AuthenticateUserUseCase } from '../../api/application/use-cases/authenticate-user.use-case.js';
import { BootstrapAdminsUseCase } from '../../api/application/use-cases/bootstrap-admins.use-case.js';
import { QuerySqlUseCase } from '../../api/application/use-cases/query-sql.use-case.js';
import {
  AuthorizationError,
  ConfigurationError,
  ForbiddenError,
  IdentityProviderError,
  UserConflictError,
  UserManagementError,
  UserNotFoundError,
} from '../../api/domain/errors.js';
import { SQL_QUERY_LIMITS } from '../../api/domain/security/query-limits.js';
import type { User } from '../../api/domain/user.js';
import { makeAdmin, makeUser, SpyDatabaseAdapter, TEST_ISSUER, TEST_ROLE_POLICY } from '../e2e-harness.js';
import { loadRealRegistry } from '../helpers.js';

const registry = loadRealRegistry();
const rolePolicy = RolePolicyLoader.parse(TEST_ROLE_POLICY, registry);

function setup(initial: User[] = [], { roles = rolePolicy } = {}) {
  let next = 0;
  const users = new InMemoryUserRepository(initial);
  const idp = new FakeIdentityProvider(TEST_ISSUER);
  for (const user of initial) {
    for (const { subject } of user.identities) {
      if (user.kind === 'human') idp.humans.set(subject, { subject, email: user.label, blocked: !user.enabled });
      else idp.clients.set(subject, { subject, clientId: subject.replace('@clients', ''), secret: 's', granted: user.enabled });
    }
  }
  const audit = new InMemoryAuditLogger();
  const internalErrors: unknown[] = [];
  const admin = new AdminUsersUseCase({
    users,
    identityProvider: idp,
    rolePolicy: roles,
    databaseKeys: ['lang', 'powerbi'],
    audit,
    logInternalError: (error) => internalErrors.push(error),
    newId: () => `id-${++next}`,
    now: () => new Date('2026-01-01T00:00:00Z'),
  });
  return { users, idp, audit, internalErrors, admin, auth: new AuthenticateUserUseCase(users) };
}

const ana = makeAdmin('ana').user;
const luis = makeAdmin('luis').user;

describe('AuthenticateUserUseCase', () => {
  const vendedor = makeUser('u1', 'ventas', 'lang');
  const disabled = makeUser('u2', 'ventas', 'lang', false);
  const service = makeUser('n8n', 'ventas', 'lang', true, 'service');
  const adminWithoutRole = makeAdmin('a1');
  const { auth } = setup([vendedor.user, disabled.user, service.user, adminWithoutRole.user]);

  it('maps (issuer, subject) to a frozen UserContext with the internal id, never the subject', async () => {
    const principal = await auth.execute({ issuer: TEST_ISSUER, subject: vendedor.subject });
    expect(principal.context).toEqual({ userId: 'u1', role: 'ventas', databaseKey: 'lang' });
    expect(principal.kind).toBe('human');
    expect(Object.isFrozen(principal.context)).toBe(true);
    expect(JSON.stringify(principal)).not.toContain(vendedor.subject);
  });

  it('a service account gets its context like a person', async () => {
    const principal = await auth.execute({ issuer: TEST_ISSUER, subject: 'n8n@clients' });
    expect(principal).toEqual({ context: { userId: 'n8n', role: 'ventas', databaseKey: 'lang' }, kind: 'service' });
  });

  it.each([
    ['unknown identity', { issuer: TEST_ISSUER, subject: 'auth0|nobody' }],
    ['same subject, other issuer', { issuer: 'https://other.test/', subject: 'auth0|u1' }],
    ['disabled user', { issuer: TEST_ISSUER, subject: disabled.subject }],
    ['admin without role', { issuer: TEST_ISSUER, subject: adminWithoutRole.subject }],
  ])('%s → the same ForbiddenError("Forbidden")', async (_case, identity) => {
    const error = await auth.execute(identity).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as Error).message).toBe('Forbidden');
  });

  it('authenticateAdmin accepts only enabled human admins', async () => {
    await expect(auth.authenticateAdmin({ issuer: TEST_ISSUER, subject: adminWithoutRole.subject })).resolves.toMatchObject({ id: 'a1' });
    for (const subject of [vendedor.subject, disabled.subject, 'n8n@clients', 'auth0|nobody']) {
      await expect(auth.authenticateAdmin({ issuer: TEST_ISSUER, subject })).rejects.toThrow(ForbiddenError);
    }
  });
});

describe('AdminUsersUseCase: invitations and password links', () => {
  it('invites a person without email: lower-cased, linked by subject, link returned once', async () => {
    const { admin, users, idp, auth } = setup([ana]);
    const result = await admin.invite(ana, { email: ' Juan@Empresa.com ', role: 'ventas', databaseKey: 'lang' });

    expect(idp.calledWith('createHuman')).toEqual([['juan@empresa.com']]);
    expect(result.passwordLink?.url).toMatch(/^https:\/\/idp\.test\/u\/reset-verify/);
    expect(result.user).toMatchObject({ id: 'id-1', kind: 'human', label: 'juan@empresa.com', admin: false, role: 'ventas' });
    const stored = await users.findById('id-1');
    expect(stored?.identities).toEqual([{ issuer: TEST_ISSUER, subject: idp.calledWith('issuePasswordLink')[0]?.[0] }]);
    expect(JSON.stringify(stored)).not.toContain('reset-verify');
    await expect(auth.execute(stored!.identities[0]!)).resolves.toMatchObject({ context: { userId: 'id-1' } });
  });

  it.each([
    [{ email: 'not-an-email' }, /valid email/],
    [{ email: 'a@b.com', role: 'ventas' }, /together/],
    [{ email: 'a@b.com', role: 'gerente', databaseKey: 'lang' }, /role "gerente" is not defined.*known: ventas/],
    [{ email: 'a@b.com', role: 'ventas', databaseKey: 'otra' }, /database key "otra".*known: lang, powerbi/],
  ])('rejects invalid input before calling the IdP %#', async (input, message) => {
    const { admin, idp } = setup([ana]);
    await expect(admin.invite(ana, input)).rejects.toThrow(message);
    expect(idp.calls).toEqual([]);
  });

  it('an email already provisioned fails without calling the IdP', async () => {
    const { admin, idp } = setup([ana]);
    await expect(admin.invite(ana, { email: 'ANA@empresa.com' })).rejects.toThrow(UserManagementError);
    await expect(admin.invite(ana, { email: 'ana@empresa.com' })).rejects.toMatchObject({ code: 'DUPLICATE_USER' });
    expect(idp.calls).toEqual([]);
  });

  it('re-links (and unblocks) a person that already exists at the IdP instead of creating it again', async () => {
    const { admin, idp } = setup([ana]);
    const subject = idp.addHuman('vieja@empresa.com');
    idp.humans.get(subject)!.blocked = true;
    await admin.invite(ana, { email: 'vieja@empresa.com' });
    expect(idp.calledWith('createHuman')).toEqual([]);
    expect(idp.humans.get(subject)?.blocked).toBe(false);
  });

  it('if saving fails after creating at the IdP, blocks the person there and grants nothing', async () => {
    const { admin, users, idp, internalErrors } = setup([ana]);
    users.failNextSave = new Error('disk full');
    await expect(admin.invite(ana, { email: 'juan@empresa.com', role: 'ventas', databaseKey: 'lang' })).rejects.toThrow('disk full');
    const [created] = idp.calledWith('createHuman');
    expect(created).toBeDefined();
    const subject = [...idp.humans.values()].find((human) => human.email === 'juan@empresa.com')!.subject;
    expect(idp.humans.get(subject)?.blocked).toBe(true);
    expect(await users.findByLabel('juan@empresa.com')).toBeNull();
    expect(internalErrors).toHaveLength(1);
    expect(idp.calledWith('issuePasswordLink')).toEqual([]);
  });

  it('if only the link fails, the user stays created and the result says to issue a new one', async () => {
    const { admin, users, idp, internalErrors } = setup([ana]);
    idp.fail('issuePasswordLink');
    const result = await admin.invite(ana, { email: 'juan@empresa.com' });
    expect(result.passwordLink).toBeNull();
    expect(await users.findByLabel('juan@empresa.com')).not.toBeNull();
    expect(internalErrors[0]).toBeInstanceOf(IdentityProviderError);
  });

  it('issues a new link for an enabled person without changing the user', async () => {
    const juan = makeUser('juan', 'ventas', 'lang');
    const { admin, users, idp } = setup([ana, juan.user]);
    const before = await users.findById('juan');
    const { passwordLink } = await admin.issuePasswordLink(ana, 'juan');
    expect(passwordLink.url).toContain('reset-verify');
    expect(passwordLink.expiresAt).toBeInstanceOf(Date);
    expect(idp.calledWith('issuePasswordLink')).toEqual([[juan.subject]]);
    expect(await users.findById('juan')).toEqual(before);
  });

  it.each([
    ['a service account', makeUser('n8n', 'ventas', 'lang', true, 'service').user, UserManagementError],
    ['a disabled person', makeUser('beto', 'ventas', 'lang', false).user, UserConflictError],
  ])('refuses a link for %s without calling the IdP', async (_case, target, errorType) => {
    const { admin, idp } = setup([ana, target]);
    await expect(admin.issuePasswordLink(ana, target.id)).rejects.toThrow(errorType);
    expect(idp.calledWith('issuePasswordLink')).toEqual([]);
  });

  it('an unknown user id → UserNotFoundError', async () => {
    const { admin } = setup([ana]);
    await expect(admin.issuePasswordLink(ana, 'nope')).rejects.toThrow(UserNotFoundError);
    await expect(admin.update(ana, 'nope', { enabled: false })).rejects.toThrow(UserNotFoundError);
  });

  it('with an empty role policy, only admins without role can be created', async () => {
    const empty = RolePolicyLoader.parse('roles: {}\n', registry);
    const { admin } = setup([ana], { roles: empty });
    await expect(admin.invite(ana, { email: 'x@b.com', role: 'ventas', databaseKey: 'lang' })).rejects.toThrow(/none defined/);
    await expect(admin.invite(ana, { email: 'x@b.com', admin: true })).resolves.toMatchObject({ user: { admin: true, role: null } });
  });
});

describe('AdminUsersUseCase: updates', () => {
  it('disabling cuts access at once and blocks the person at the IdP', async () => {
    const juan = makeUser('juan', 'ventas', 'lang');
    const { admin, auth, idp } = setup([ana, juan.user]);
    const result = await admin.update(ana, 'juan', { enabled: false });
    expect(result).toMatchObject({ user: { enabled: false }, identityProviderSynced: true });
    expect(idp.humans.get(juan.subject)?.blocked).toBe(true);
    await expect(auth.execute({ issuer: TEST_ISSUER, subject: juan.subject })).rejects.toThrow(ForbiddenError);
  });

  it('IdP down while disabling: still disabled here, the failure is reported and logged', async () => {
    const juan = makeUser('juan', 'ventas', 'lang');
    const { admin, auth, idp, internalErrors } = setup([ana, juan.user]);
    idp.fail('setHumanBlocked');
    const result = await admin.update(ana, 'juan', { enabled: false });
    expect(result.identityProviderSynced).toBe(false);
    expect(internalErrors).toHaveLength(1);
    await expect(auth.execute({ issuer: TEST_ISSUER, subject: juan.subject })).rejects.toThrow(ForbiddenError);
  });

  it('re-enabling unblocks at the IdP first; if that fails nothing is saved', async () => {
    const beto = makeUser('beto', 'ventas', 'lang', false);
    const { admin, users, idp } = setup([ana, beto.user]);
    idp.fail('setHumanBlocked');
    await expect(admin.update(ana, 'beto', { enabled: true })).rejects.toThrow(IdentityProviderError);
    expect((await users.findById('beto'))?.enabled).toBe(false);

    idp.recover('setHumanBlocked');
    await admin.update(ana, 'beto', { enabled: true });
    expect(idp.humans.get(beto.subject)?.blocked).toBe(false);
    expect((await users.findById('beto'))?.enabled).toBe(true);
  });

  it('disabling a service account revokes its grant; enabling restores it', async () => {
    const n8n = makeUser('n8n', 'ventas', 'lang', true, 'service');
    const { admin, idp } = setup([ana, n8n.user]);
    await admin.update(ana, 'n8n', { enabled: false });
    expect(idp.clients.get('n8n@clients')?.granted).toBe(false);
    await admin.update(ana, 'n8n', { enabled: true });
    expect(idp.clients.get('n8n@clients')?.granted).toBe(true);
  });

  it('role and databaseKey change together, and null removes both', async () => {
    const juan = makeUser('juan', 'ventas', 'lang');
    const { admin } = setup([ana, juan.user]);
    await expect(admin.update(ana, 'juan', { role: 'compras' })).rejects.toThrow(/together/);
    await expect(admin.update(ana, 'juan', { role: null, databaseKey: 'lang' })).rejects.toThrow(/together/);
    await expect(admin.update(ana, 'juan', { role: 'compras', databaseKey: 'powerbi' })).resolves.toMatchObject({
      user: { role: 'compras', databaseKey: 'powerbi' },
    });
    await expect(admin.update(ana, 'juan', { role: null, databaseKey: null })).resolves.toMatchObject({
      user: { role: null, databaseKey: null },
    });
  });

  it('a service account cannot become an admin', async () => {
    const n8n = makeUser('n8n', 'ventas', 'lang', true, 'service');
    const { admin, users } = setup([ana, n8n.user]);
    await expect(admin.update(ana, 'n8n', { admin: true })).rejects.toThrow(/service account cannot be an admin/);
    expect((await users.findById('n8n'))?.admin).toBe(false);
  });

  it('the last enabled admin cannot disable or demote itself', async () => {
    const { admin, users } = setup([ana]);
    await expect(admin.update(ana, 'ana', { enabled: false })).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    await expect(admin.update(ana, 'ana', { admin: false })).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    expect(await users.findById('ana')).toMatchObject({ admin: true, enabled: true });
  });

  it('with two admins, one can remove the other', async () => {
    const { admin } = setup([ana, luis]);
    await expect(admin.update(ana, 'luis', { admin: false })).resolves.toMatchObject({ user: { admin: false } });
  });
});

describe('AdminUsersUseCase: service accounts', () => {
  it('creates an M2M client and returns the secret once; the repository never holds it', async () => {
    const { admin, users, idp, auth } = setup([ana]);
    const result = await admin.createServiceAccount(ana, { name: 'n8n-reportes', role: 'ventas', databaseKey: 'lang' });
    expect(result).toMatchObject({ clientId: 'client-1', clientSecret: 'secret-1', user: { kind: 'service', label: 'n8n-reportes' } });
    expect(JSON.stringify(await users.list())).not.toContain('secret-1');
    await expect(auth.execute({ issuer: TEST_ISSUER, subject: 'client-1@clients' })).resolves.toMatchObject({ kind: 'service' });
    expect(idp.calledWith('createServiceClient')).toEqual([['n8n-reportes']]);
  });

  it.each([
    [{ name: 'n8n', role: 'ventas', databaseKey: 'otra' }, /database key/],
    [{ name: 'N', role: 'ventas', databaseKey: 'lang' }, /name must be/],
    [{ name: 'n8n', role: 'gerente', databaseKey: 'lang' }, /role "gerente"/],
  ])('rejects invalid input before creating anything at the IdP %#', async (input, message) => {
    const { admin, idp } = setup([ana]);
    await expect(admin.createServiceAccount(ana, input)).rejects.toThrow(message);
    expect(idp.calls).toEqual([]);
  });

  it('if saving fails, revokes the client grant', async () => {
    const { admin, users, idp } = setup([ana]);
    users.failNextSave = new Error('disk full');
    await expect(admin.createServiceAccount(ana, { name: 'n8n', role: 'ventas', databaseKey: 'lang' })).rejects.toThrow();
    expect(idp.clients.get('client-1@clients')?.granted).toBe(false);
  });

  it('rotates the secret only for service accounts', async () => {
    const n8n = makeUser('n8n', 'ventas', 'lang', true, 'service');
    const { admin } = setup([ana, n8n.user]);
    const rotated = await admin.rotateServiceSecret(ana, 'n8n');
    expect(rotated).toEqual({ clientId: 'n8n', clientSecret: expect.stringMatching(/^secret-/) });
    await expect(admin.rotateServiceSecret(ana, 'ana')).rejects.toThrow(UserManagementError);
  });
});

describe('admin audit', () => {
  it('records actor, action, target and field names: never emails, subjects, secrets or links', async () => {
    const { admin, audit, idp } = setup([ana, luis]);
    const invited = await admin.invite(ana, { email: 'juan@empresa.com', role: 'ventas', databaseKey: 'lang' });
    await admin.issuePasswordLink(ana, invited.user.id);
    await admin.update(ana, invited.user.id, { role: 'compras', databaseKey: 'lang' });
    await admin.update(ana, invited.user.id, { enabled: false });
    await admin.update(ana, invited.user.id, { enabled: true });
    const service = await admin.createServiceAccount(ana, { name: 'n8n', role: 'ventas', databaseKey: 'lang' });
    const rotated = await admin.rotateServiceSecret(ana, service.user.id);

    expect(audit.adminEvents.map((event) => event.action)).toEqual([
      'invite_user',
      'issue_password_link',
      'update_user',
      'disable_user',
      'enable_user',
      'create_service_account',
      'rotate_service_secret',
    ]);
    expect(audit.adminEvents[2]).toMatchObject({ actorUserId: 'ana', targetUserId: invited.user.id, changedFields: ['role'], success: true });

    const serialized = JSON.stringify(audit.adminEvents);
    for (const secret of [
      'juan@empresa.com',
      ...[...idp.humans.keys()],
      invited.passwordLink!.url,
      service.clientSecret,
      rotated.clientSecret,
      'client-1@clients',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('records rejected operations with their error code', async () => {
    const { admin, audit } = setup([ana]);
    await admin.update(ana, 'ana', { enabled: false }).catch(() => undefined);
    expect(audit.adminEvents).toEqual([
      expect.objectContaining({ action: 'disable_user', actorUserId: 'ana', targetUserId: 'ana', success: false, errorCode: 'LAST_ADMIN' }),
    ]);
  });
});

describe('BootstrapAdminsUseCase', () => {
  function bootstrap(initial: User[] = []) {
    let next = 0;
    const users = new InMemoryUserRepository(initial);
    const idp = new FakeIdentityProvider(TEST_ISSUER);
    const audit = new InMemoryAuditLogger();
    const useCase = new BootstrapAdminsUseCase({ users, identityProvider: idp, audit, newId: () => `boot-${++next}` });
    return { users, idp, audit, useCase };
  }

  it('first deploy: links people created by hand at the IdP as admins without /mcp access', async () => {
    const { users, idp, audit, useCase } = bootstrap();
    const subject = idp.addHuman('ana@empresa.com');
    await expect(useCase.execute(['Ana@Empresa.com'])).resolves.toBe(1);
    expect(await users.list()).toEqual([
      expect.objectContaining({ label: 'ana@empresa.com', admin: true, enabled: true, identities: [{ issuer: TEST_ISSUER, subject }] }),
    ]);
    expect((await users.list())[0]?.role).toBeUndefined();
    expect(audit.adminEvents).toEqual([expect.objectContaining({ actorUserId: 'bootstrap', action: 'bootstrap_admin', success: true })]);
    // Never creates users nor issues links.
    expect(idp.calledWith('createHuman')).toEqual([]);
    expect(idp.calledWith('issuePasswordLink')).toEqual([]);
  });

  it('an email without a user at the IdP aborts startup and writes nothing', async () => {
    const { users, idp, useCase } = bootstrap();
    idp.addHuman('ana@empresa.com');
    await expect(useCase.execute(['ana@empresa.com', 'luis@empresa.com'])).rejects.toThrow(ConfigurationError);
    await expect(useCase.execute(['luis@empresa.com'])).rejects.toThrow(/create it there first/);
    expect(await users.list()).toEqual([]);
    expect(idp.calledWith('createHuman')).toEqual([]);
  });

  it('is ignored when an enabled admin exists (an old .env cannot revive a removed admin)', async () => {
    const removed = makeAdmin('luis', {}, false).user;
    const { users, idp, useCase } = bootstrap([ana, removed]);
    idp.addHuman('luis@empresa.com');
    await expect(useCase.execute(['luis@empresa.com'])).resolves.toBe(0);
    expect((await users.findById('luis'))?.enabled).toBe(false);
    expect(idp.calls).toEqual([]);
  });

  it('IdP down → startup fails', async () => {
    const { idp, useCase } = bootstrap();
    idp.fail('findHumanByEmail');
    await expect(useCase.execute(['ana@empresa.com'])).rejects.toThrow(IdentityProviderError);
  });

  it('does nothing without emails', async () => {
    const { idp, useCase } = bootstrap();
    await expect(useCase.execute([])).resolves.toBe(0);
    expect(idp.calls).toEqual([]);
  });
});

describe('QuerySqlUseCase', () => {
  const authorization = new AuthorizationService(rolePolicy, registry);
  const limiter = () => new SlidingWindowRateLimiter({ maxRequests: 100, windowMs: 60_000 });

  it('rejects a role not in circuit-access.yaml even if called directly, before touching the database', async () => {
    const database = new SpyDatabaseAdapter();
    const useCase = new QuerySqlUseCase(authorization, limiter(), database, SQL_QUERY_LIMITS);
    expect(() => useCase.execute({ userId: 'u', role: 'sin_rol', databaseKey: 'lang' }, 'SELECT 1')).toThrow(
      AuthorizationError,
    );
    expect(database.calls).toEqual([]);
  });

  it('runs on the UserContext database with the configured limits', async () => {
    const database = new SpyDatabaseAdapter();
    const useCase = new QuerySqlUseCase(authorization, limiter(), database, { maxRows: 7, timeoutMs: 1234 });
    await useCase.execute({ userId: 'u', role: 'analista', databaseKey: 'powerbi' }, 'SELECT 1');
    expect(database.calls).toEqual([{ databaseKey: 'powerbi', sql: 'SELECT 1' }]);
    expect(database.sqlOptions).toEqual([{ maxRows: 7, timeoutMs: 1234 }]);
  });
});
