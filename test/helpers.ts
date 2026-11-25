import { createHmac, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createLocalJWKSet, type JWK } from 'jose';
import type { AdminEvent, ToolEvent } from '../api/audit.js';
import { createTokenVerifier } from '../api/auth.js';
import { Auth0Error, type Auth0 } from '../api/auth0.js';
import { parseCatalog } from '../api/circuits.js';
import type { RunSql, SqlResult } from '../api/db.js';
import { createHttpServer, type App } from '../api/http.js';
import { createRateLimiter } from '../api/tools/query-sql.js';
import { createUserStore, type UserRecord, type UserStore } from '../api/users.js';

export const CIRCUITS_FILE = fileURLToPath(new URL('../config/circuits.yaml', import.meta.url));

export const TEST_ROLES = `
roles:
  ventas:
    circuits: [venta, envio_comprobantes, usuario]
  compras:
    circuits: [compras]
  analista:
    circuits: [venta]
`;
export const TEST_DATABASE_KEYS = ['tenant_a', 'tenant_b'];

/** Real circuits.yaml with the test roles. */
export const testCatalog = () => parseCatalog(readFileSync(CIRCUITS_FILE, 'utf8'), TEST_ROLES);

/** Fake OAuth world: one issuer, two audiences, one RSA signing key in a local JWKS. */
export const ISSUER = 'https://idp.test/';
export const RESOURCE = 'https://mcp.test/mcp';
export const ADMIN_AUDIENCE = 'https://mcp.test/admin-api';
const KID = 'test-key';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWKS = { keys: [{ ...(keys.publicKey.export({ format: 'jwk' }) as JWK), kid: KID, alg: 'RS256', use: 'sig' }] };

/** A compact JWT for /mcp unless `aud` says otherwise. `exp` defaults to 10 minutes from now. */
export function signJwt(
  claims: Record<string, unknown>,
  { alg = 'RS256', key = keys.privateKey }: { alg?: 'RS256' | 'HS256' | 'none'; key?: KeyObject } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg, typ: 'JWT', kid: KID })}.${encode({ iss: ISSUER, aud: RESOURCE, iat: now, exp: now + 600, ...claims })}`;
  if (alg === 'none') return `${input}.`;
  if (alg === 'HS256') return `${input}.${createHmac('sha256', 'shared').update(input).digest('base64url')}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(key).toString('base64url')}`;
}

export const adminToken = (subject: string) => signJwt({ sub: subject, aud: ADMIN_AUDIENCE });

export interface TestUser {
  record: UserRecord;
  subject: string;
  /** For /mcp. */
  token: string;
  /** For /admin/api. */
  adminToken: string;
}

function testUser(record: Omit<UserRecord, 'identities' | 'createdAt'>, subject: string): TestUser {
  return {
    record: { ...record, identities: [{ issuer: ISSUER, subject }], createdAt: '2026-01-01T00:00:00.000Z' },
    subject,
    token: signJwt({ sub: subject }),
    adminToken: adminToken(subject),
  };
}

export function makeUser(id: string, role: string | undefined, databaseKey: string | undefined, enabled = true, kind: 'human' | 'service' = 'human'): TestUser {
  const access = role === undefined ? {} : { role, ...(databaseKey === undefined ? {} : { databaseKey }) };
  return testUser({ id, kind, label: id, admin: false, enabled, ...access } as UserRecord, kind === 'service' ? `${id}@clients` : `auth0|${id}`);
}

/** An admin; without role/databaseKey unless given (no /mcp access). */
export function makeAdmin(id: string, access: { role?: string; databaseKey?: string } = {}, enabled = true): TestUser {
  return testUser({ id, kind: 'human', label: `${id}@empresa.com`, admin: true, enabled, ...access }, `auth0|${id}`);
}

/** Records every SQL call; answers with `respond`. Proves what reaches (or not) the database. */
export function spyDatabase(respond: (databaseKey: string, sql: string) => SqlResult | Error = () => ({ columns: [], rows: [], rowCount: 0, truncated: false })) {
  const calls: Array<{ databaseKey: string; sql: string }> = [];
  const runSql: RunSql = async (databaseKey, sql) => {
    calls.push({ databaseKey, sql });
    const result = respond(databaseKey, sql);
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, runSql };
}

type Auth0Method = Exclude<keyof Auth0, 'issuer'>;

/** In-memory Auth0: records calls, keeps people and clients, and can be told to fail a method. */
export function fakeAuth0() {
  const calls: Array<{ method: Auth0Method; args: unknown[] }> = [];
  const failing = new Set<Auth0Method>();
  const humans = new Map<string, { email: string; blocked: boolean }>();
  const clients = new Map<string, { clientId: string; secret: string; granted: boolean }>();
  let sequence = 0;
  const record = (method: Auth0Method, ...args: unknown[]) => {
    calls.push({ method, args });
    if (failing.has(method)) throw new Auth0Error(`Auth0: ${method} failed`);
  };
  const client = (subject: string) => {
    const found = clients.get(subject);
    if (!found) throw new Auth0Error('unknown client');
    return found;
  };

  const auth0: Auth0 = {
    issuer: ISSUER,
    async createHuman(email) {
      record('createHuman', email);
      const subject = `auth0|fake-${++sequence}`;
      humans.set(subject, { email, blocked: false });
      return subject;
    },
    async findHumanByEmail(email) {
      record('findHumanByEmail', email);
      return [...humans].find(([, human]) => human.email === email)?.[0] ?? null;
    },
    async issuePasswordLink(subject) {
      record('issuePasswordLink', subject);
      return { url: `https://idp.test/u/reset-verify?ticket=t${++sequence}`, expiresAt: '2030-01-01T00:00:00.000Z' };
    },
    async setHumanBlocked(subject, blocked) {
      record('setHumanBlocked', subject, blocked);
      const human = humans.get(subject);
      if (human) human.blocked = blocked;
    },
    async createServiceClient(name) {
      record('createServiceClient', name);
      const clientId = `client-${++sequence}`;
      clients.set(`${clientId}@clients`, { clientId, secret: `secret-${sequence}`, granted: true });
      return { subject: `${clientId}@clients`, clientId, clientSecret: `secret-${sequence}` };
    },
    async rotateServiceSecret(subject) {
      record('rotateServiceSecret', subject);
      const found = client(subject);
      found.secret = `secret-${++sequence}`;
      return { clientId: found.clientId, clientSecret: found.secret };
    },
    async revokeServiceClient(subject) {
      record('revokeServiceClient', subject);
      client(subject).granted = false;
    },
    async restoreServiceClient(subject) {
      record('restoreServiceClient', subject);
      client(subject).granted = true;
    },
  };

  return {
    auth0,
    calls,
    humans,
    clients,
    fail: (method: Auth0Method) => failing.add(method),
    recover: (method: Auth0Method) => failing.delete(method),
    calledWith: (method: Auth0Method) => calls.filter((call) => call.method === method).map((call) => call.args),
    /** A person created by hand in Auth0 (e.g. the first admin). */
    addHuman: (email: string, subject = `auth0|${email}`) => {
      humans.set(subject, { email, blocked: false });
      return subject;
    },
  };
}

/** A users.yaml in a temp folder, pre-filled. */
export function tempUserStore(users: TestUser[] = []): UserStore {
  const store = createUserStore(join(mkdtempSync(join(tmpdir(), 'mcp-popey-')), 'users.yaml'));
  for (const user of users) store.save(user.record);
  return store;
}

export interface TestApp {
  app: App;
  url: URL;
  origin: string;
  toolEvents: ToolEvent[];
  adminEvents: AdminEvent[];
  users: UserStore;
  idp: ReturnType<typeof fakeAuth0>;
  close(): Promise<void>;
}

export function testApp(users: TestUser[], overrides: Partial<App> = {}): Omit<TestApp, 'url' | 'origin' | 'close'> {
  const toolEvents: ToolEvent[] = [];
  const adminEvents: AdminEvent[] = [];
  const store = tempUserStore(users);
  const idp = fakeAuth0();
  for (const { record, subject } of users) if (record.kind === 'human') idp.humans.set(subject, { email: record.label, blocked: !record.enabled });
  const app: App = {
    issuer: ISSUER,
    resourceUrl: RESOURCE,
    verifyToken: createTokenVerifier({ issuer: ISSUER, audiences: { mcp: RESOURCE, admin: ADMIN_AUDIENCE }, keys: createLocalJWKSet(JWKS) }),
    users: store,
    auth0: idp.auth0,
    databaseKeys: TEST_DATABASE_KEYS,
    catalog: testCatalog(),
    runSql: spyDatabase().runSql,
    maxRows: 1_000,
    rateLimit: createRateLimiter({ maxRequests: 1_000, windowMs: 60_000 }),
    audit: (event) => ('action' in event ? adminEvents.push(event) : toolEvents.push(event)),
    ...overrides,
  };
  return { app, toolEvents, adminEvents, users: app.users, idp };
}

export async function startTestApp(users: TestUser[], overrides: Partial<App> = {}): Promise<TestApp> {
  const built = testApp(users, overrides);
  const server = createHttpServer(built.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { ...built, url: new URL(`${origin}/mcp`), origin, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

export async function connectClient(url: URL, token: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

/** Calls a tool and parses its JSON text. SDK-level input errors also come back as isError. */
export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; data: any }> {
  try {
    const result = await client.callTool({ name, arguments: args });
    const first = (result.content as Array<{ type: string; text?: string }>)[0];
    const text = first?.text ?? '';
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // plain text (SDK validation message)
    }
    return { isError: result.isError === true, data };
  } catch (error) {
    return { isError: true, data: { protocolError: error instanceof Error ? error.message : String(error) } };
  }
}
