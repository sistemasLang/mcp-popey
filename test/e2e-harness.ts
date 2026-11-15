import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApplication, type Application, type ApplicationOptions } from '../api/composition/container.js';
import { InMemoryAuditLogger } from '../api/adapters/outbound/memory/in-memory-audit.logger.js';
import { generateToken, hashToken } from '../api/domain/auth-token.js';
import { DatabaseRegistry } from '../api/adapters/outbound/postgres/database.registry.js';
import type {
  ReadOnlyDatabasePort,
  SelectOptions,
  SelectResult,
  SqlOptions,
  SqlResult,
} from '../api/application/ports/outbound/database.port.js';
import { RolePolicyLoader } from '../api/adapters/outbound/yaml/role-policy.loader.js';
import { QUERY_LIMITS } from '../api/domain/security/query-limits.js';
import type { UserRecord } from '../api/domain/user.js';
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
    sql: true
`;

export interface TestUser {
  record: UserRecord;
  token: string;
}

export function makeUser(id: string, role: string, databaseKey: string, enabled = true): TestUser {
  const token = generateToken();
  return {
    token,
    record: { id, username: id, role, databaseKey, enabled, tokenSha256: hashToken(token), createdAt: '' },
  };
}

/** Records every call; returns canned rows. Proves what reaches (or not) the database. */
export class SpyDatabaseAdapter implements ReadOnlyDatabasePort {
  readonly calls: Array<{ databaseKey: string; sql: string; params: unknown[] }> = [];
  constructor(private readonly respond: (databaseKey: string) => SelectResult | Error = () => ({ rows: [], rowCount: 0 })) {}

  async executeSelect(databaseKey: string, sql: string, params: unknown[], _options: SelectOptions): Promise<SelectResult> {
    this.calls.push({ databaseKey, sql, params });
    const response = this.respond(databaseKey);
    if (response instanceof Error) throw response;
    return response;
  }

  async executeSql(databaseKey: string, sql: string, options: SqlOptions): Promise<SqlResult> {
    this.calls.push({ databaseKey, sql, params: [] });
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
  audit: InMemoryAuditLogger;
  close(): Promise<void>;
}

export async function startTestApp(
  users: TestUser[],
  overrides: Partial<ApplicationOptions> = {},
): Promise<TestApp> {
  const circuitRegistry = loadRealRegistry();
  const audit = new InMemoryAuditLogger();
  const app = createApplication({
    circuitRegistry,
    rolePolicy: RolePolicyLoader.parse(TEST_ROLE_POLICY, circuitRegistry),
    users: new InMemoryUserRepository(users.map((user) => user.record)),
    databases: DatabaseRegistry.fromConfigs({}),
    queryLimits: QUERY_LIMITS,
    rateLimit: { maxRequests: 1_000, windowMs: 60_000 },
    dbPoolMax: 2,
    audit,
    ...overrides,
  });
  await new Promise<void>((resolve) => app.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = app.httpServer.address() as AddressInfo;
  return { app, url: new URL(`http://127.0.0.1:${port}/mcp`), audit, close: () => app.close() };
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
