import { createHmac, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createLocalJWKSet, type JWK } from 'jose';
import { createApplication, type Application, type ApplicationOptions } from '../api/composition/container.js';
import { JwtAccessTokenVerifier } from '../api/adapters/inbound/http/jwt-access-token.verifier.js';
import { FakeIdentityProvider } from '../api/adapters/outbound/memory/fake-identity-provider.js';
import { InMemoryAuditLogger } from '../api/adapters/outbound/memory/in-memory-audit.logger.js';
import { DatabaseRegistry } from '../api/adapters/outbound/postgres/database.registry.js';
import type { ReadOnlyDatabasePort, SqlOptions, SqlResult } from '../api/application/ports/outbound/database.port.js';
import { RolePolicyLoader } from '../api/adapters/outbound/yaml/role-policy.loader.js';
import type { User, UserKind } from '../api/domain/user.js';
import { InMemoryUserRepository } from '../api/adapters/outbound/memory/in-memory-user.repository.js';
import { loadRealRegistry } from './helpers.js';

export const TEST_ROLE_POLICY = `
roles:
  ventas:
    circuits: [venta, envio_comprobantes, usuario]
  compras:
    circuits: [compras]
  analista:
    circuits: [venta]
`;

/** Fake OAuth world: one issuer, two audiences, one RSA signing key published in a local JWKS. */
export const TEST_ISSUER = 'https://idp.test/';
export const TEST_MCP_AUDIENCE = 'https://mcp.test/mcp';
export const TEST_ADMIN_AUDIENCE = 'https://mcp.test/admin-api';
export const TEST_DATABASE_KEYS = ['tenant_a', 'tenant_b'];

const KID = 'test-key';
const signingKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const TEST_JWKS = {
  keys: [{ ...(signingKeys.publicKey.export({ format: 'jwk' }) as JWK), kid: KID, alg: 'RS256', use: 'sig' }],
};

export function testTokenVerifier(): JwtAccessTokenVerifier {
  return new JwtAccessTokenVerifier({
    issuer: TEST_ISSUER,
    audiences: { mcp: TEST_MCP_AUDIENCE, admin: TEST_ADMIN_AUDIENCE },
    keys: createLocalJWKSet(TEST_JWKS),
  });
}

const base64url = (value: object | Buffer) =>
  (Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))).toString('base64url');

export interface SignOptions {
  alg?: 'RS256' | 'HS256' | 'none';
  /** Another private key (a signature the JWKS does not know). */
  key?: KeyObject;
}

/** Builds a compact JWT synchronously. `exp` defaults to 10 minutes from now. */
export function signJwt(claims: Record<string, unknown>, { alg = 'RS256', key = signingKeys.privateKey }: SignOptions = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg, typ: 'JWT', kid: KID });
  const payload = base64url({ iss: TEST_ISSUER, iat: now, exp: now + 600, ...claims });
  const input = `${header}.${payload}`;
  if (alg === 'none') return `${input}.`;
  if (alg === 'HS256') return `${input}.${createHmac('sha256', 'shared-secret').update(input).digest('base64url')}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(key).toString('base64url')}`;
}

export const mcpToken = (subject: string, claims: Record<string, unknown> = {}) =>
  signJwt({ sub: subject, aud: TEST_MCP_AUDIENCE, ...claims });

export const adminToken = (subject: string, claims: Record<string, unknown> = {}) =>
  signJwt({ sub: subject, aud: TEST_ADMIN_AUDIENCE, ...claims });

export interface TestUser {
  user: User;
  subject: string;
  /** Access token for /mcp. */
  token: string;
  /** Access token for /admin/api. */
  adminToken: string;
}

function testUser(user: Omit<User, 'identities' | 'createdAt'>, subject: string): TestUser {
  return {
    user: { ...user, identities: [{ issuer: TEST_ISSUER, subject }], createdAt: '2026-01-01T00:00:00.000Z' },
    subject,
    token: mcpToken(subject),
    adminToken: adminToken(subject),
  };
}

export function makeUser(id: string, role: string, databaseKey: string, enabled = true, kind: UserKind = 'human'): TestUser {
  const subject = kind === 'service' ? `${id}@clients` : `auth0|${id}`;
  return testUser({ id, kind, label: id, admin: false, enabled, role, databaseKey }, subject);
}

/** An admin; without role/databaseKey unless given (no /mcp access). */
export function makeAdmin(id: string, access: { role?: string; databaseKey?: string } = {}, enabled = true): TestUser {
  return testUser({ id, kind: 'human', label: `${id}@empresa.com`, admin: true, enabled, ...access }, `auth0|${id}`);
}

/** Records every call; returns canned rows. Proves what reaches (or not) the database. */
export interface CannedRows {
  rows: Record<string, unknown>[];
  rowCount: number;
}

export class SpyDatabaseAdapter implements ReadOnlyDatabasePort {
  readonly calls: Array<{ databaseKey: string; sql: string }> = [];
  constructor(private readonly respond: (databaseKey: string) => CannedRows | Error = () => ({ rows: [], rowCount: 0 })) {}

  async executeSql(databaseKey: string, sql: string, options: SqlOptions): Promise<SqlResult> {
    this.calls.push({ databaseKey, sql });
    this.sqlOptions.push(options);
    const response = this.respond(databaseKey);
    if (response instanceof Error) throw response;
    return { columns: Object.keys(response.rows[0] ?? {}), rows: response.rows, rowCount: response.rowCount, truncated: false };
  }

  readonly sqlOptions: SqlOptions[] = [];
}

export interface TestApp {
  app: Application;
  url: URL;
  origin: string;
  audit: InMemoryAuditLogger;
  users: InMemoryUserRepository;
  idp: FakeIdentityProvider;
  close(): Promise<void>;
}

export async function startTestApp(users: TestUser[], overrides: Partial<ApplicationOptions> = {}): Promise<TestApp> {
  const circuitRegistry = loadRealRegistry();
  const audit = new InMemoryAuditLogger();
  const repository = new InMemoryUserRepository(users.map((testUser) => testUser.user));
  const idp = new FakeIdentityProvider(TEST_ISSUER);
  for (const { user, subject } of users) if (user.kind === 'human') idp.humans.set(subject, { subject, email: user.label, blocked: !user.enabled });
  for (const { user, subject } of users) {
    if (user.kind === 'service') idp.clients.set(subject, { subject, clientId: subject.replace('@clients', ''), secret: 's', granted: user.enabled });
  }
  const app = createApplication({
    circuitRegistry,
    rolePolicy: RolePolicyLoader.parse(TEST_ROLE_POLICY, circuitRegistry),
    users: repository,
    databases: DatabaseRegistry.fromConfigs(
      Object.fromEntries(
        TEST_DATABASE_KEYS.map((key) => [key, { host: 'localhost', port: 5432, database: key, user: 'u', password: 'p', ssl: false }]),
      ),
    ),
    tokens: testTokenVerifier(),
    identityProvider: idp,
    mcpResourceUrl: TEST_MCP_AUDIENCE,
    rateLimit: { maxRequests: 1_000, windowMs: 60_000 },
    dbPoolMax: 2,
    audit,
    ...overrides,
  });
  await new Promise<void>((resolve) => app.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = app.httpServer.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return { app, url: new URL(`${origin}/mcp`), origin, audit, users: repository, idp, close: () => app.close() };
}

export async function connectClient(url: URL, token: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return client;
}

export interface ToolOutcome {
  isError: boolean;
  data: any;
}

/** Calls a tool and parses the JSON text payload. SDK-level input errors surface as isError too. */
export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  try {
    const result = await client.callTool({ name, arguments: args });
    const first = (result.content as Array<{ type: string; text?: string }>)[0];
    const text = first?.type === 'text' ? (first.text ?? '') : '';
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // Non-JSON text (e.g. SDK validation message).
    }
    return { isError: result.isError === true, data };
  } catch (error) {
    return { isError: true, data: { protocolError: error instanceof Error ? error.message : String(error) } };
  }
}
