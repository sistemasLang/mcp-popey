import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapAdmins } from '../../api/admin.js';
import { ConfigError } from '../../api/errors.js';
import { adminToken, callTool, connectClient, makeAdmin, makeUser, signJwt, startTestApp, testApp, type TestApp } from '../helpers.js';

/** /admin/api over real HTTP, with an in-memory Auth0. */
const ana = makeAdmin('ana');
const luis = makeAdmin('luis');
const vendedor = makeUser('vendedor', 'ventas', 'tenant_a');
const exAdmin = makeAdmin('ex', {}, false);
const n8n = makeUser('n8n', 'ventas', 'tenant_a', true, 'service');

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp([ana, luis, vendedor, exAdmin, n8n]);
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  app.adminEvents.length = 0;
  app.idp.calls.length = 0;
});

async function call(target: TestApp, method: string, path: string, { token = ana.adminToken, body }: { token?: string | null; body?: unknown } = {}) {
  const response = await fetch(`${target.origin}/admin/api/${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : undefined, text };
}
const api = (method: string, path: string, options?: { token?: string | null; body?: unknown }) => call(app, method, path, options);

describe('admin API authentication', () => {
  it('no token → 401 and Auth0 is not called', async () => {
    expect((await api('POST', 'users', { token: null, body: { email: 'x@y.com' } })).status).toBe(401);
    expect(app.idp.calls).toEqual([]);
  });

  it('a /mcp token → 401 (audiences are separate); an admin token on /mcp → 401 too', async () => {
    expect((await api('GET', 'users', { token: makeAdmin('ana', { role: 'ventas', databaseKey: 'tenant_a' }).token })).status).toBe(401);
    const mcp = await fetch(app.url, { method: 'POST', headers: { Authorization: `Bearer ${ana.adminToken}` } });
    expect(mcp.status).toBe(401);
  });

  it.each([
    ['a person without admin', vendedor.adminToken],
    ['a disabled admin with a live token', exAdmin.adminToken],
    ['a service account', adminToken(n8n.subject)],
    ['an unknown identity', adminToken('auth0|nobody')],
  ])('%s → 403 Forbidden', async (_case, token) => {
    const response = await api('GET', 'users', { token });
    expect(response.status).toBe(403);
    expect(response.json).toEqual({ error: { code: 'FORBIDDEN', message: 'Forbidden' } });
  });

  it('unknown routes → 404 and wrong methods → 405, after authentication', async () => {
    expect((await api('GET', 'nope')).status).toBe(404);
    expect((await api('GET', 'nope', { token: null })).status).toBe(401);
    const wrongMethod = await api('DELETE', 'users');
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET, POST');
  });
});

describe('admin API operations', () => {
  it('catalog lists roles and database keys, without connection data', async () => {
    const response = await api('GET', 'catalog');
    expect(response.json).toEqual({ roles: ['analista', 'compras', 'ventas'], databaseKeys: ['tenant_a', 'tenant_b'] });
  });

  it('the listing never exposes Auth0 subjects', async () => {
    const response = await api('GET', 'users');
    expect(response.json.users.find((user: { id: string }) => user.id === 'ana')).toEqual({
      id: 'ana',
      kind: 'human',
      label: 'ana@empresa.com',
      admin: true,
      role: null,
      databaseKey: null,
      enabled: true,
      createdAt: expect.any(String),
    });
    expect(response.text).not.toMatch(/auth0\||@clients|identities|issuer/);
  });

  it('invite → 201 with a one-time passwordLink and no-store; users.yaml keeps no link; the person can use /mcp', async () => {
    const response = await api('POST', 'users', { body: { email: 'Juan@Empresa.com', role: 'ventas', databaseKey: 'tenant_a' } });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.json).toMatchObject({
      user: { kind: 'human', label: 'juan@empresa.com', role: 'ventas', databaseKey: 'tenant_a', enabled: true },
      passwordLink: { url: expect.stringContaining('reset-verify'), expiresAt: '2030-01-01T00:00:00.000Z' },
    });
    expect(JSON.stringify(app.users.list())).not.toContain(response.json.passwordLink.url);
    expect(app.adminEvents).toEqual([
      expect.objectContaining({ actorUserId: 'ana', action: 'invite_user', targetUserId: response.json.user.id, success: true }),
    ]);

    // Once they log in to Auth0, their /mcp token works.
    const subject = app.users.findById(response.json.user.id)!.identities[0]!.subject;
    const client = await connectClient(app.url, signJwt({ sub: subject }));
    expect((await callTool(client, 'list_circuits')).data.circuits.length).toBeGreaterThan(0);
    await client.close();

    const regenerated = await api('POST', `users/${response.json.user.id}/password-link`);
    expect(regenerated.status).toBe(200);
    expect(regenerated.json.passwordLink.url).not.toBe(response.json.passwordLink.url);
    expect(JSON.stringify(app.adminEvents)).not.toContain('reset-verify');
  });

  it('invite reuses and unblocks a person left over in Auth0 instead of creating it again', async () => {
    const subject = app.idp.addHuman('resto@empresa.com');
    app.idp.humans.get(subject)!.blocked = true;
    const response = await api('POST', 'users', { body: { email: 'resto@empresa.com' } });
    expect(response.status).toBe(201);
    expect(app.idp.calledWith('createHuman')).toEqual([]);
    expect(app.idp.humans.get(subject)?.blocked).toBe(false);
  });

  it('invite when only the link fails → 201 with passwordLink null and the reason', async () => {
    app.idp.fail('issuePasswordLink');
    try {
      const response = await api('POST', 'users', { body: { email: 'sinlink@empresa.com' } });
      expect(response.status).toBe(201);
      expect(response.json).toMatchObject({ passwordLink: null, passwordLinkError: 'IDENTITY_PROVIDER_ERROR' });
    } finally {
      app.idp.recover('issuePasswordLink');
    }
  });

  it('Auth0 down → 502 and nothing is saved', async () => {
    app.idp.fail('createHuman');
    try {
      const before = app.users.list().length;
      const response = await api('POST', 'users', { body: { email: 'caido@empresa.com' } });
      expect(response.status).toBe(502);
      expect(response.json.error.code).toBe('IDENTITY_PROVIDER_ERROR');
      expect(app.users.list().length).toBe(before);
      expect(app.adminEvents).toEqual([expect.objectContaining({ success: false, errorCode: 'IDENTITY_PROVIDER_ERROR' })]);
    } finally {
      app.idp.recover('createHuman');
    }
  });

  it.each([
    ['an extra property', { email: 'a@b.com', identities: [{ issuer: 'x', subject: 'y' }] }],
    ['a wrong type', { email: 'a@b.com', admin: 'yes' }],
    ['invalid JSON', '{"email":'],
  ])('a body with %s → 400, nothing created, and the rejection is audited', async (_case, body) => {
    const before = app.users.list().length;
    const response = await api('POST', 'users', { body });
    expect(response.status).toBe(400);
    expect(response.json.error.code).toBe('INVALID_REQUEST');
    expect(app.users.list().length).toBe(before);
    expect(app.idp.calls).toEqual([]);
    expect(app.adminEvents).toEqual([expect.objectContaining({ action: 'invite_user', success: false, errorCode: 'INVALID_REQUEST' })]);
  });

  it('a body over 16 KiB → 413', async () => {
    expect((await api('POST', 'users', { body: JSON.stringify({ email: 'a'.repeat(20_000) }) })).status).toBe(413);
  });

  it('an unknown role or tenant → 400 listing the known ones, before calling Auth0', async () => {
    const role = await api('POST', 'users', { body: { email: 'a@b.com', role: 'auditor', databaseKey: 'tenant_a' } });
    expect(role.status).toBe(400);
    expect(role.json.error.message).toMatch(/known: ventas, compras, analista/);
    const tenant = await api('POST', 'users', { body: { email: 'a@b.com', role: 'ventas', databaseKey: 'otra' } });
    expect(tenant.json.error.message).toMatch(/known: tenant_a, tenant_b/);
    expect((await api('POST', 'users', { body: { email: 'a@b.com', role: 'ventas' } })).status).toBe(400);
    expect(app.idp.calls).toEqual([]);
  });

  it('an email already provisioned → 409; an invalid email → 400', async () => {
    expect((await api('POST', 'users', { body: { email: 'ana@empresa.com' } })).json.error.code).toBe('DUPLICATE_USER');
    expect((await api('POST', 'users', { body: { email: 'no-es-mail' } })).status).toBe(400);
  });

  it('PATCH an unknown id → 404 without calling Auth0; an empty body → 400', async () => {
    expect((await api('PATCH', 'users/does-not-exist', { body: { enabled: false } })).status).toBe(404);
    expect((await api('PATCH', 'users/vendedor', { body: {} })).status).toBe(400);
    expect(app.idp.calls).toEqual([]);
  });

  it('role and databaseKey change together; null removes both (no /mcp access)', async () => {
    expect((await api('PATCH', 'users/vendedor', { body: { role: 'compras' } })).status).toBe(400);
    const removed = await api('PATCH', 'users/vendedor', { body: { role: null, databaseKey: null } });
    expect(removed.json.user).toMatchObject({ role: null, databaseKey: null });
    expect((await fetch(app.url, { method: 'POST', headers: { Authorization: `Bearer ${vendedor.token}` } })).status).toBe(403);
    await api('PATCH', 'users/vendedor', { body: { role: 'ventas', databaseKey: 'tenant_a' } });
  });

  it('a service account cannot become an admin', async () => {
    expect((await api('PATCH', 'users/n8n', { body: { admin: true } })).status).toBe(400);
  });

  it('password link for a service account → 400, for a disabled person → 409', async () => {
    expect((await api('POST', 'users/n8n/password-link')).status).toBe(400);
    expect((await api('POST', 'users/ex/password-link')).status).toBe(409);
    expect(app.idp.calledWith('issuePasswordLink')).toEqual([]);
  });

  it('the last enabled admin cannot disable or demote itself → 409', async () => {
    const solo = makeAdmin('solo');
    const alone = await startTestApp([solo]);
    try {
      for (const body of [{ enabled: false }, { admin: false }]) {
        const response = await call(alone, 'PATCH', 'users/solo', { token: solo.adminToken, body });
        expect(response.status).toBe(409);
        expect(response.json.error.code).toBe('LAST_ADMIN');
      }
      expect(alone.users.findById('solo')?.enabled).toBe(true);
    } finally {
      await alone.close();
    }
  });

  it('disabling cuts access at once and blocks the person in Auth0; with Auth0 down it is cut anyway (warning)', async () => {
    const temp = makeUser('temp', 'ventas', 'tenant_a');
    app.users.save(temp.record);
    app.idp.humans.set(temp.subject, { email: 'temp', blocked: false });
    expect((await api('PATCH', 'users/temp', { body: { enabled: false } })).json.warning).toBeUndefined();
    expect(app.idp.humans.get(temp.subject)?.blocked).toBe(true);
    expect((await fetch(app.url, { method: 'POST', headers: { Authorization: `Bearer ${temp.token}` } })).status).toBe(403);

    await api('PATCH', 'users/temp', { body: { enabled: true } });
    app.idp.fail('setHumanBlocked');
    try {
      const response = await api('PATCH', 'users/temp', { body: { enabled: false } });
      expect(response.json).toMatchObject({ user: { enabled: false }, warning: 'IDENTITY_PROVIDER_SYNC_FAILED' });
      expect(app.users.findById('temp')?.enabled).toBe(false);
    } finally {
      app.idp.recover('setHumanBlocked');
    }
  });

  it('re-enabling unblocks in Auth0 first; if that fails nothing is saved', async () => {
    app.idp.fail('setHumanBlocked');
    try {
      expect((await api('PATCH', 'users/ex', { body: { enabled: true } })).status).toBe(502);
      expect(app.users.findById('ex')?.enabled).toBe(false);
    } finally {
      app.idp.recover('setHumanBlocked');
    }
  });

  it('service account: secret returned once, never stored, listed or audited; rotation too; disable revokes the grant', async () => {
    const created = await api('POST', 'service-accounts', { body: { name: 'n8n-reportes', role: 'ventas', databaseKey: 'tenant_a' } });
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    expect(created.json).toMatchObject({ clientId: expect.any(String), clientSecret: expect.any(String), user: { kind: 'service' } });

    const rotated = await api('POST', `service-accounts/${created.json.user.id}/rotate-secret`);
    expect(rotated.json.clientSecret).not.toBe(created.json.clientSecret);
    const listing = await api('GET', 'users');
    for (const secret of [created.json.clientSecret, rotated.json.clientSecret]) {
      expect(JSON.stringify(app.users.list())).not.toContain(secret);
      expect(listing.text).not.toContain(secret);
      expect(JSON.stringify(app.adminEvents)).not.toContain(secret);
    }
    expect(app.adminEvents.map((event) => event.action)).toEqual(['create_service_account', 'rotate_service_secret']);

    const subject = `${created.json.clientId}@clients`;
    await api('PATCH', `users/${created.json.user.id}`, { body: { enabled: false } });
    expect(app.idp.clients.get(subject)?.granted).toBe(false);
    await api('PATCH', `users/${created.json.user.id}`, { body: { enabled: true } });
    expect(app.idp.clients.get(subject)?.granted).toBe(true);
  });

  it('a service account without role, or with a bad name → 400 and nothing is created in Auth0', async () => {
    expect((await api('POST', 'service-accounts', { body: { name: 'x1' } })).status).toBe(400);
    expect((await api('POST', 'service-accounts', { body: { name: 'Con Espacios', role: 'ventas', databaseKey: 'tenant_a' } })).status).toBe(400);
    expect(app.idp.calls).toEqual([]);
  });

  it('every write leaves an admin audit event without emails, subjects or secrets', async () => {
    await api('PATCH', 'users/vendedor', { body: { role: 'compras', databaseKey: 'tenant_b' } });
    await api('PATCH', 'users/vendedor', { body: { enabled: false } });
    await api('PATCH', 'users/vendedor', { body: { enabled: true } });
    expect(app.adminEvents.map(({ action, changedFields }) => ({ action, changedFields }))).toEqual([
      { action: 'update_user', changedFields: ['role', 'databaseKey'] },
      { action: 'disable_user', changedFields: ['enabled'] },
      { action: 'enable_user', changedFields: ['enabled'] },
    ]);
    expect(JSON.stringify(app.adminEvents)).not.toMatch(/@|auth0\|/);
  });
});

describe('bootstrap of the first admins (BOOTSTRAP_ADMIN_EMAILS)', () => {
  it('links people created by hand in Auth0 as admins without /mcp access', async () => {
    const fresh = testApp([]);
    const subject = fresh.idp.addHuman('jefe@empresa.com');
    expect(await bootstrapAdmins(fresh.app, ['jefe@empresa.com'])).toBe(1);
    expect(fresh.users.findByIdentity(fresh.app.issuer, subject)).toMatchObject({ admin: true, enabled: true })
    expect(fresh.users.findByIdentity(fresh.app.issuer, subject)?.role).toBeUndefined();
    expect(fresh.idp.calledWith('createHuman')).toEqual([]);
    expect(fresh.adminEvents).toEqual([expect.objectContaining({ actorUserId: 'bootstrap', action: 'bootstrap_admin' })]);
  });

  it('an email without a user in Auth0 stops the start and writes nothing', async () => {
    const fresh = testApp([]);
    await expect(bootstrapAdmins(fresh.app, ['nadie@empresa.com'])).rejects.toBeInstanceOf(ConfigError);
    expect(fresh.users.list()).toEqual([]);
  });

  it('is ignored when an enabled admin exists (an old .env cannot revive a removed admin)', async () => {
    const existing = testApp([makeAdmin('ana')]);
    existing.idp.addHuman('otro@empresa.com');
    expect(await bootstrapAdmins(existing.app, ['otro@empresa.com'])).toBe(0);
    expect(existing.idp.calls).toEqual([]);
  });
});
