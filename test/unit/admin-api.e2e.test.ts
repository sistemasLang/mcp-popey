import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminToken, makeAdmin, makeUser, startTestApp, type TestApp } from '../e2e-harness.js';

/** /admin/api over real HTTP, with the fake identity provider. */
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
  app.audit.adminEvents.length = 0;
  app.idp.calls.length = 0;
});

async function call(method: string, path: string, { token = ana.adminToken, body }: { token?: string | null; body?: unknown } = {}) {
  const response = await fetch(`${app.origin}/admin/api/${path}`, {
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

describe('admin API authentication', () => {
  it('no token → 401 and the IdP is not called', async () => {
    const response = await call('POST', 'users', { token: null, body: { email: 'x@y.com' } });
    expect(response.status).toBe(401);
    expect(app.idp.calls).toEqual([]);
  });

  it('a /mcp token → 401 (audiences are separate)', async () => {
    expect((await call('GET', 'users', { token: ana.token })).status).toBe(401);
  });

  it.each([
    ['a person without admin', vendedor.adminToken],
    ['a disabled admin with a live token', exAdmin.adminToken],
    ['a service account', adminToken(n8n.subject)],
    ['an unknown identity', adminToken('auth0|nobody')],
  ])('%s → 403 Forbidden', async (_case, token) => {
    const response = await call('GET', 'users', { token });
    expect(response.status).toBe(403);
    expect(response.json).toEqual({ error: { code: 'FORBIDDEN', message: 'Forbidden' } });
  });

  it('unknown routes → 404 and wrong methods → 405, after authentication', async () => {
    expect((await call('GET', 'nope')).status).toBe(404);
    expect((await call('GET', 'nope', { token: null })).status).toBe(401);
    const wrongMethod = await call('DELETE', 'users');
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET, POST');
  });
});

describe('admin API operations', () => {
  it('catalog lists roles and database keys, without connection data', async () => {
    const response = await call('GET', 'catalog');
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ roles: ['analista', 'compras', 'ventas'], databaseKeys: ['tenant_a', 'tenant_b'] });
    expect(response.text).not.toMatch(/localhost|password/);
  });

  it('the listing never exposes IdP subjects', async () => {
    const response = await call('GET', 'users');
    expect(response.status).toBe(200);
    expect(response.json.users[0]).toEqual({
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

  it('invite → 201 with a one-time passwordLink and no-store; users.yaml keeps neither link nor secret', async () => {
    const response = await call('POST', 'users', { body: { email: 'Juan@Empresa.com', role: 'ventas', databaseKey: 'tenant_a' } });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.json).toMatchObject({
      user: { kind: 'human', label: 'juan@empresa.com', role: 'ventas', databaseKey: 'tenant_a', enabled: true },
      passwordLink: { url: expect.stringContaining('reset-verify'), expiresAt: '2030-01-01T00:00:00.000Z' },
    });
    expect(JSON.stringify(await app.users.list())).not.toContain(response.json.passwordLink.url);
    expect(app.audit.adminEvents).toEqual([
      expect.objectContaining({ actorUserId: 'ana', action: 'invite_user', targetUserId: response.json.user.id, success: true }),
    ]);

    const regenerated = await call('POST', `users/${response.json.user.id}/password-link`);
    expect(regenerated.status).toBe(200);
    expect(regenerated.headers.get('cache-control')).toBe('no-store');
    expect(regenerated.json.passwordLink.url).not.toBe(response.json.passwordLink.url);
    expect(JSON.stringify(app.audit.adminEvents)).not.toContain('reset-verify');
  });

  it('invite when only the link fails → 201 with passwordLink null and the reason', async () => {
    app.idp.fail('issuePasswordLink');
    try {
      const response = await call('POST', 'users', { body: { email: 'sinlink@empresa.com' } });
      expect(response.status).toBe(201);
      expect(response.json).toMatchObject({ passwordLink: null, passwordLinkError: 'IDENTITY_PROVIDER_ERROR' });
    } finally {
      app.idp.recover('issuePasswordLink');
    }
  });

  it.each([
    ['an extra property', { email: 'a@b.com', identities: [{ issuer: 'x', subject: 'y' }] }],
    ['a wrong type', { email: 'a@b.com', admin: 'yes' }],
    ['invalid JSON', '{"email":'],
  ])('a body with %s → 400, nothing created, and the rejection is audited', async (_case, body) => {
    const before = (await app.users.list()).length;
    const response = await call('POST', 'users', { body });
    expect(response.status).toBe(400);
    expect(response.json.error.code).toBe('INVALID_REQUEST');
    expect((await app.users.list()).length).toBe(before);
    expect(app.idp.calls).toEqual([]);
    expect(app.audit.adminEvents).toEqual([
      expect.objectContaining({ action: 'invite_user', success: false, errorCode: 'INVALID_REQUEST' }),
    ]);
  });

  it('an unknown role → 400 listing the known ones, before calling the IdP', async () => {
    const response = await call('POST', 'users', { body: { email: 'a@b.com', role: 'auditor', databaseKey: 'tenant_a' } });
    expect(response.status).toBe(400);
    expect(response.json.error.message).toMatch(/known: ventas, compras, analista/);
    expect(app.idp.calls).toEqual([]);
  });

  it('an email already provisioned → 409', async () => {
    const response = await call('POST', 'users', { body: { email: 'ana@empresa.com' } });
    expect(response.status).toBe(409);
    expect(response.json.error.code).toBe('DUPLICATE_USER');
  });

  it('PATCH an unknown id → 404 without calling the IdP', async () => {
    const response = await call('PATCH', 'users/does-not-exist', { body: { enabled: false } });
    expect(response.status).toBe(404);
    expect(app.idp.calls).toEqual([]);
  });

  it('PATCH with an empty body → 400', async () => {
    expect((await call('PATCH', 'users/vendedor', { body: {} })).status).toBe(400);
  });

  it('password link for a service account → 400, for a disabled person → 409', async () => {
    expect((await call('POST', 'users/n8n/password-link')).status).toBe(400);
    expect((await call('POST', 'users/ex/password-link')).status).toBe(409);
    expect(app.idp.calledWith('issuePasswordLink')).toEqual([]);
  });

  it('the last admin cannot be left: with two admins one can go, then the other is protected → 409', async () => {
    const solo = await startTestApp([makeAdmin('solo')]);
    try {
      const response = await fetch(`${solo.origin}/admin/api/users/solo`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${makeAdmin('solo').adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('LAST_ADMIN');
      expect(solo.audit.adminEvents).toEqual([expect.objectContaining({ success: false, errorCode: 'LAST_ADMIN' })]);
      expect((await solo.users.findById('solo'))?.enabled).toBe(true);
    } finally {
      await solo.close();
    }
  });

  it('disabling with the IdP down → 200 with a warning, and the user is cut anyway', async () => {
    const temp = makeUser('temp', 'ventas', 'tenant_a');
    await app.users.save(temp.user);
    app.idp.fail('setHumanBlocked');
    try {
      const response = await call('PATCH', 'users/temp', { body: { enabled: false } });
      expect(response.status).toBe(200);
      expect(response.json).toMatchObject({ user: { enabled: false }, warning: 'IDENTITY_PROVIDER_SYNC_FAILED' });
      expect((await app.users.findById('temp'))?.enabled).toBe(false);
    } finally {
      app.idp.recover('setHumanBlocked');
    }
  });

  it('service account: secret returned once, never stored, never listed, never audited; rotation too', async () => {
    const created = await call('POST', 'service-accounts', { body: { name: 'n8n-reportes', role: 'ventas', databaseKey: 'tenant_a' } });
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    expect(created.json).toMatchObject({ clientId: expect.any(String), clientSecret: expect.any(String), user: { kind: 'service' } });
    const secret: string = created.json.clientSecret;

    const rotated = await call('POST', `service-accounts/${created.json.user.id}/rotate-secret`);
    expect(rotated.status).toBe(200);
    expect(rotated.json.clientSecret).not.toBe(secret);

    const listing = await call('GET', 'users');
    for (const value of [secret, rotated.json.clientSecret]) {
      expect(JSON.stringify(await app.users.list())).not.toContain(value);
      expect(listing.text).not.toContain(value);
      expect(JSON.stringify(app.audit.adminEvents)).not.toContain(value);
    }
    expect(app.audit.adminEvents.map((event) => event.action)).toEqual(['create_service_account', 'rotate_service_secret']);
  });

  it('a service account without role → 400 and nothing is created at the IdP', async () => {
    const response = await call('POST', 'service-accounts', { body: { name: 'x1' } });
    expect(response.status).toBe(400);
    expect(app.idp.calls).toEqual([]);
  });

  it('every write leaves an admin audit event without emails, subjects or secrets', async () => {
    await call('PATCH', 'users/vendedor', { body: { role: 'compras', databaseKey: 'tenant_b' } });
    await call('PATCH', 'users/vendedor', { body: { enabled: false } });
    await call('PATCH', 'users/vendedor', { body: { enabled: true } });
    expect(app.audit.adminEvents.map(({ action, changedFields }) => ({ action, changedFields }))).toEqual([
      { action: 'update_user', changedFields: ['role', 'databaseKey'] },
      { action: 'disable_user', changedFields: ['enabled'] },
      { action: 'enable_user', changedFields: ['enabled'] },
    ]);
    expect(JSON.stringify(app.audit.adminEvents)).not.toMatch(/@|auth0\|/);
  });
});
