import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { AdminAction } from './audit.js';
import { adminUser, bearerToken } from './auth.js';
import { Auth0Error, type PasswordLink } from './auth0.js';
import { ConfigError, logInternalError } from './errors.js';
import type { App } from './http.js';
import { InvalidUserError, toView, type UserRecord, type UserStore } from './users.js';

/**
 * /admin/api/*: the API of the admin panel (frontend/). Only for enabled people
 * with admin: true, with a token whose audience is ADMIN_API_AUDIENCE (a /mcp
 * token does not work here, nor the other way round).
 *
 *   GET   catalog                              roles and databaseKeys that can be assigned
 *   GET   users                                everyone (without identities)
 *   POST  users                                invite a person → password link, shown once
 *   POST  users/:id/password-link              a new link (also "forgot my password")
 *   PATCH users/:id                            role + tenant, admin, enabled
 *   POST  service-accounts                     n8n & co → clientId + clientSecret, shown once
 *   POST  service-accounts/:id/rotate-secret   new clientSecret, shown once
 *
 * Rules: role and tenant must exist; at least one enabled admin always remains;
 * Auth0 is called first and users.yaml second, undoing the Auth0 side if saving
 * fails. Every write is audited (who, what, which fields) without emails, secrets or links.
 */

export const ADMIN_PREFIX = '/admin/api/';
const MAX_BODY_BYTES = 16 * 1024;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SERVICE_NAME = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/** An error the panel can show: HTTP status + code + safe message. */
class AdminError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}
const invalid = (message: string) => new AdminError(400, 'USER_MANAGEMENT_ERROR', message);
const conflict = (code: string, message: string) => new AdminError(409, code, message);

const Name = z.string().min(1).max(64);
const Invite = z.object({ email: z.string().max(254), admin: z.boolean().optional(), role: Name.optional(), databaseKey: Name.optional() }).strict();
const Patch = z
  .object({ admin: z.boolean().optional(), enabled: z.boolean().optional(), role: Name.nullable().optional(), databaseKey: Name.nullable().optional() })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'at least one field is required');
const ServiceAccount = z.object({ name: z.string().max(64), role: Name, databaseKey: Name }).strict();
const Empty = z.object({}).strict().optional();

/** What a write records in the audit log; handlers fill it in as they learn it. */
interface Draft {
  action: AdminAction;
  targetUserId?: string;
  changedFields: string[];
}

interface Ctx {
  app: App;
  id: string;
  body: any;
  draft: Draft;
}

interface Route {
  method: 'GET' | 'POST' | 'PATCH';
  pattern: RegExp;
  action?: AdminAction;
  schema?: z.ZodType;
  handle: (ctx: Ctx) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown };
}

const ID = '([A-Za-z0-9-]{1,64})';

const ROUTES: Route[] = [
  {
    method: 'GET',
    pattern: /^catalog$/,
    handle: ({ app }) => ({ status: 200, body: { roles: [...app.catalog.roles.keys()].sort(), databaseKeys: app.databaseKeys } }),
  },
  {
    method: 'GET',
    pattern: /^users$/,
    handle: ({ app }) => ({ status: 200, body: { users: app.users.list().map(toView) } }),
  },
  { method: 'POST', pattern: /^users$/, action: 'invite_user', schema: Invite, handle: invite },
  {
    method: 'POST',
    pattern: new RegExp(`^users/${ID}/password-link$`),
    action: 'issue_password_link',
    schema: Empty,
    handle: async ({ app, id, draft }) => {
      draft.targetUserId = id;
      const user = find(app.users, id);
      if (user.kind !== 'human') throw invalid('password links are only for people');
      if (!user.enabled) throw conflict('USER_DISABLED', 'enable the user before issuing a password link');
      return { status: 200, body: { passwordLink: await app.auth0.issuePasswordLink(subjectOf(app, user)) } };
    },
  },
  { method: 'PATCH', pattern: new RegExp(`^users/${ID}$`), action: 'update_user', schema: Patch, handle: update },
  { method: 'POST', pattern: /^service-accounts$/, action: 'create_service_account', schema: ServiceAccount, handle: createServiceAccount },
  {
    method: 'POST',
    pattern: new RegExp(`^service-accounts/${ID}/rotate-secret$`),
    action: 'rotate_service_secret',
    schema: Empty,
    handle: async ({ app, id, draft }) => {
      Object.assign(draft, { targetUserId: id, changedFields: ['clientSecret'] });
      const user = find(app.users, id);
      if (user.kind !== 'service') throw invalid('only service accounts have a secret');
      return { status: 200, body: await app.auth0.rotateServiceSecret(subjectOf(app, user)) };
    },
  },
];

async function invite({ app, body, draft }: Ctx) {
  const email = body.email.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) throw invalid('email must be a valid email address');
  const access = checkAccess(app, body.role, body.databaseKey);
  draft.changedFields = ['admin', ...Object.keys(access)];

  const existing = app.users.findByLabel(email);
  if (existing) {
    draft.targetUserId = existing.id;
    throw conflict('DUPLICATE_USER', 'a user with that email already exists');
  }
  // The person may already exist in Auth0 (left over from an earlier, failed attempt): reuse it.
  const found = await app.auth0.findHumanByEmail(email);
  if (found && app.users.findByIdentity(app.auth0.issuer, found)) {
    throw conflict('DUPLICATE_IDENTITY', 'that identity is already linked to another user');
  }
  const subject = found ?? (await app.auth0.createHuman(email));
  if (found) await app.auth0.setHumanBlocked(subject, false);

  const user: UserRecord = {
    id: randomUUID(),
    kind: 'human',
    label: email,
    admin: body.admin ?? false,
    enabled: true,
    ...access,
    identities: [{ issuer: app.auth0.issuer, subject }],
    createdAt: new Date().toISOString(),
  };
  draft.targetUserId = user.id;
  await saveOrUndo(app, user, () => app.auth0.setHumanBlocked(subject, true));

  // The user exists even if the link fails: the panel offers "new link".
  let passwordLink: PasswordLink | null = null;
  try {
    passwordLink = await app.auth0.issuePasswordLink(subject);
  } catch (error) {
    logInternalError(error);
  }
  return {
    status: 201,
    body: { user: toView(user), passwordLink, ...(passwordLink ? {} : { passwordLinkError: 'IDENTITY_PROVIDER_ERROR' }) },
  };
}

async function update({ app, id, body, draft }: Ctx) {
  draft.targetUserId = id;
  const current = find(app.users, id);
  const next: UserRecord = { ...current };
  if (body.admin !== undefined) next.admin = body.admin;
  if (body.enabled !== undefined) next.enabled = body.enabled;
  if (body.role !== undefined || body.databaseKey !== undefined) {
    if (body.role === undefined || body.databaseKey === undefined || (body.role === null) !== (body.databaseKey === null)) {
      throw invalid('role and databaseKey must be changed together');
    }
    delete next.role;
    delete next.databaseKey;
    Object.assign(next, checkAccess(app, body.role ?? undefined, body.databaseKey ?? undefined));
  }
  if (next.kind === 'service' && next.admin) throw invalid('a service account cannot be an admin');

  draft.changedFields = (['admin', 'enabled', 'role', 'databaseKey'] as const).filter((field) => current[field] !== next[field]);
  if (current.enabled !== next.enabled) draft.action = next.enabled ? 'enable_user' : 'disable_user';
  if (draft.changedFields.length === 0) return { status: 200, body: { user: toView(current) } };

  if (current.admin && current.enabled && !(next.admin && next.enabled) && app.users.countEnabledAdmins() <= 1) {
    throw conflict('LAST_ADMIN', 'at least one enabled admin must remain');
  }

  if (current.enabled && !next.enabled) {
    // Disabling: cut access here first, so it holds even if Auth0 is down.
    save(app.users, next);
    try {
      await setAuth0Access(app, next, false);
      return { status: 200, body: { user: toView(next) } };
    } catch (error) {
      logInternalError(error);
      return { status: 200, body: { user: toView(next), warning: 'IDENTITY_PROVIDER_SYNC_FAILED' } };
    }
  }
  // Re-enabling: Auth0 first, so a saved "enabled" user can really log in.
  if (!current.enabled && next.enabled) await setAuth0Access(app, next, true);
  save(app.users, next);
  return { status: 200, body: { user: toView(next) } };
}

async function createServiceAccount({ app, body, draft }: Ctx) {
  const name = body.name.trim().toLowerCase();
  if (!SERVICE_NAME.test(name)) throw invalid('name must be 2-64 chars [a-z0-9._-]');
  const access = checkAccess(app, body.role, body.databaseKey);
  draft.changedFields = ['role', 'databaseKey'];
  const existing = app.users.findByLabel(name);
  if (existing) {
    draft.targetUserId = existing.id;
    throw conflict('DUPLICATE_USER', 'a user with that name already exists');
  }

  const created = await app.auth0.createServiceClient(name);
  const user: UserRecord = {
    id: randomUUID(),
    kind: 'service',
    label: name,
    admin: false,
    enabled: true,
    ...access,
    identities: [{ issuer: app.auth0.issuer, subject: created.subject }],
    createdAt: new Date().toISOString(),
  };
  draft.targetUserId = user.id;
  await saveOrUndo(app, user, () => app.auth0.revokeServiceClient(created.subject));
  // The secret is returned once and never stored on this server.
  return { status: 201, body: { user: toView(user), clientId: created.clientId, clientSecret: created.clientSecret } };
}

/** role + databaseKey: both or neither, and both must exist. Checked before calling Auth0. */
function checkAccess(app: App, role?: string, databaseKey?: string): { role?: string; databaseKey?: string } {
  if (role === undefined && databaseKey === undefined) return {};
  if (role === undefined || databaseKey === undefined) throw invalid('role and databaseKey must be set together or not at all');
  if (!app.catalog.roles.has(role)) {
    throw invalid(`role "${role}" is not defined in circuit-access.yaml (known: ${[...app.catalog.roles.keys()].join(', ') || 'none defined'})`);
  }
  if (!app.databaseKeys.includes(databaseKey)) {
    throw invalid(`database key "${databaseKey}" is not configured in DATABASE_KEYS (known: ${app.databaseKeys.join(', ') || 'none configured'})`);
  }
  return { role, databaseKey };
}

function find(users: UserStore, id: string): UserRecord {
  const user = users.findById(id);
  if (!user) throw new AdminError(404, 'USER_NOT_FOUND', 'user not found');
  return user;
}

function subjectOf(app: App, user: UserRecord): string {
  const identity = user.identities.find((candidate) => candidate.issuer === app.auth0.issuer);
  if (!identity) throw invalid('user has no identity at the configured Auth0 tenant');
  return identity.subject;
}

function setAuth0Access(app: App, user: UserRecord, allowed: boolean): Promise<void> {
  const subject = subjectOf(app, user);
  if (user.kind === 'human') return app.auth0.setHumanBlocked(subject, !allowed);
  return allowed ? app.auth0.restoreServiceClient(subject) : app.auth0.revokeServiceClient(subject);
}

function save(users: UserStore, user: UserRecord): void {
  try {
    users.save(user);
  } catch (error) {
    if (error instanceof InvalidUserError) throw conflict('DUPLICATE_IDENTITY', error.message);
    throw error;
  }
}

/** Saves; if that fails, undoes the Auth0 side (best effort) so the orphan identity cannot log in. */
async function saveOrUndo(app: App, user: UserRecord, undo: () => Promise<void>): Promise<void> {
  try {
    save(app.users, user);
  } catch (error) {
    if (!(error instanceof AdminError)) await undo().catch(logInternalError);
    throw error;
  }
}

export async function handleAdminApi(app: App, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const token = bearerToken(request);
  const subject = token ? await app.verifyToken(token, 'admin') : null;
  if (!subject) {
    response.setHeader('WWW-Authenticate', 'Bearer');
    return writeError(response, 401, 'UNAUTHORIZED', 'Unauthorized');
  }
  const actor = adminUser(app.users, app.issuer, subject);
  if (!actor) return writeError(response, 403, 'FORBIDDEN', 'Forbidden');

  const relative = path.slice(ADMIN_PREFIX.length);
  const matching = ROUTES.filter((route) => route.pattern.test(relative));
  if (matching.length === 0) return writeError(response, 404, 'NOT_FOUND', 'Not found');
  const route = matching.find((candidate) => candidate.method === request.method);
  if (!route) {
    response.setHeader('Allow', matching.map((candidate) => candidate.method).join(', '));
    return writeError(response, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }
  const id = route.pattern.exec(relative)?.[1] ?? '';
  const draft: Draft = { action: route.action ?? 'invite_user', changedFields: [], ...(id ? { targetUserId: id } : {}) };
  const audit = (success: boolean, errorCode?: string) => {
    if (!route.action) return; // reads are not audited
    app.audit({ timestamp: new Date().toISOString(), actorUserId: actor.id, ...draft, success, ...(errorCode ? { errorCode } : {}) });
  };

  let body: unknown;
  if (route.schema) {
    let parsed;
    try {
      parsed = route.schema.safeParse(await readBody(request));
    } catch (error) {
      audit(false, 'INVALID_REQUEST');
      return writeError(response, error instanceof BodyTooLarge ? 413 : 400, 'INVALID_REQUEST', 'Invalid JSON body');
    }
    if (!parsed.success) {
      audit(false, 'INVALID_REQUEST');
      return writeError(response, 400, 'INVALID_REQUEST', z.prettifyError(parsed.error));
    }
    body = parsed.data;
  }

  try {
    const result = await route.handle({ app, id, body, draft });
    audit(true);
    writeJson(response, result.status, result.body);
  } catch (error) {
    if (error instanceof AdminError) {
      audit(false, error.code);
      return writeError(response, error.status, error.code, error.message);
    }
    logInternalError(error);
    if (error instanceof Auth0Error) {
      audit(false, 'IDENTITY_PROVIDER_ERROR');
      return writeError(response, 502, 'IDENTITY_PROVIDER_ERROR', 'The identity provider failed; try again');
    }
    audit(false, 'INTERNAL_ERROR');
    writeError(response, 500, 'INTERNAL_ERROR', 'An internal error occurred');
  }
}

/**
 * First admins of a fresh install (BOOTSTRAP_ADMIN_EMAILS). Runs only while no
 * enabled admin exists, so an old value can never revive a removed admin. It only
 * LINKS people already created by hand in Auth0, with their own password: it never
 * creates users there nor issues links. Any problem stops the start before writing.
 */
export async function bootstrapAdmins(app: App, emails: string[]): Promise<number> {
  if (emails.length === 0 || app.users.countEnabledAdmins() > 0) return 0;
  const pending: UserRecord[] = [];
  for (const email of new Set(emails)) {
    if (app.users.findByLabel(email)) {
      throw new ConfigError(`BOOTSTRAP_ADMIN_EMAILS: ${email} already exists in the users file but no admin is enabled; fix the file by hand`);
    }
    const subject = await app.auth0.findHumanByEmail(email);
    if (!subject) {
      throw new ConfigError(`BOOTSTRAP_ADMIN_EMAILS: ${email} has no user in Auth0; create it there first, with its own password`);
    }
    if (app.users.findByIdentity(app.auth0.issuer, subject)) {
      throw new ConfigError(`BOOTSTRAP_ADMIN_EMAILS: the identity of ${email} is already linked to another user`);
    }
    const identities = [{ issuer: app.auth0.issuer, subject }];
    pending.push({ id: randomUUID(), kind: 'human', label: email, admin: true, enabled: true, identities, createdAt: new Date().toISOString() });
  }
  for (const user of pending) {
    app.users.save(user);
    app.audit({
      timestamp: new Date().toISOString(),
      actorUserId: 'bootstrap',
      action: 'bootstrap_admin',
      targetUserId: user.id,
      changedFields: ['admin'],
      success: true,
    });
  }
  return pending.length;
}

class BodyTooLarge extends Error {}

/** Empty body → undefined. Throws on invalid JSON or more than 16 KiB. */
async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text === '' ? undefined : JSON.parse(text);
}

function writeError(response: ServerResponse, status: number, code: string, message: string): void {
  writeJson(response, status, { error: { code, message } });
}

/** no-store on every response: links and secrets must never be cached. */
function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response
    .writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    .end(JSON.stringify(body));
}
