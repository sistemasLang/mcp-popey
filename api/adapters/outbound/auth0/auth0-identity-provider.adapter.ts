import { randomBytes } from 'node:crypto';
import type {
  IdentityProviderPort,
  PasswordLink,
  ServiceCredentials,
} from '../../../application/ports/outbound/identity-provider.port.js';
import { IdentityProviderError } from '../../../domain/errors.js';

export interface Auth0Options {
  /** Tenant domain, e.g. `empresa.us.auth0.com` (no scheme). */
  domain: string;
  /** M2M app of this server for the Management API. */
  clientId: string;
  clientSecret: string;
  /** Database connection where people live. */
  connection: string;
  /** API identifier of the MCP resource: the only audience service accounts get. */
  mcpAudience: string;
  passwordLinkTtlSeconds: number;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Renew the Management API token this long before it expires. */
const TOKEN_RENEW_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * IdentityProviderPort over the Auth0 Management API v2, with plain fetch.
 * The only file that knows Auth0. Errors never carry response bodies,
 * credentials, emails or ticket URLs: only the operation and HTTP status.
 */
export class Auth0IdentityProvider implements IdentityProviderPort {
  readonly issuer: string;
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly options: Auth0Options) {
    this.baseUrl = `https://${options.domain}`;
    this.issuer = `${this.baseUrl}/`;
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async createHuman(email: string): Promise<{ subject: string }> {
    const created = await this.call<{ user_id: string }>('create user', 'POST', '/api/v2/users', {
      email,
      connection: this.options.connection,
      password: randomPassword(),
      email_verified: false,
      // No email of any kind: the admin hands out the password link.
      verify_email: false,
    });
    return { subject: created.user_id };
  }

  async issuePasswordLink(subject: string): Promise<PasswordLink> {
    const issuedAt = this.now();
    const { ticket } = await this.call<{ ticket: string }>('create password ticket', 'POST', '/api/v2/tickets/password-change', {
      user_id: subject,
      ttl_sec: this.options.passwordLinkTtlSeconds,
      mark_email_as_verified: false,
    });
    return { url: ticket, expiresAt: new Date(issuedAt + this.options.passwordLinkTtlSeconds * 1000) };
  }

  async findHumanByEmail(email: string): Promise<{ subject: string } | null> {
    const users = await this.call<Array<{ user_id: string; identities?: Array<{ connection?: string }> }>>(
      'find user by email',
      'GET',
      `/api/v2/users-by-email?email=${encodeURIComponent(email)}`,
    );
    const user = users.find((candidate) =>
      candidate.identities?.some((identity) => identity.connection === this.options.connection),
    );
    return user ? { subject: user.user_id } : null;
  }

  async setHumanBlocked(subject: string, blocked: boolean): Promise<void> {
    await this.call('update user', 'PATCH', `/api/v2/users/${encodeURIComponent(subject)}`, { blocked });
  }

  async createServiceClient(name: string): Promise<ServiceCredentials & { subject: string }> {
    const client = await this.call<{ client_id: string; client_secret: string }>('create client', 'POST', '/api/v2/clients', {
      name: `mcp-popey ${name}`,
      app_type: 'non_interactive',
      grant_types: ['client_credentials'],
    });
    await this.grant(client.client_id);
    return { subject: subjectOf(client.client_id), clientId: client.client_id, clientSecret: client.client_secret };
  }

  async rotateServiceSecret(subject: string): Promise<ServiceCredentials> {
    const clientId = clientIdOf(subject);
    const client = await this.call<{ client_id: string; client_secret: string }>(
      'rotate client secret',
      'POST',
      `/api/v2/clients/${encodeURIComponent(clientId)}/rotate-secret`,
    );
    return { clientId: client.client_id, clientSecret: client.client_secret };
  }

  async revokeServiceClient(subject: string): Promise<void> {
    const clientId = clientIdOf(subject);
    const query = `client_id=${encodeURIComponent(clientId)}&audience=${encodeURIComponent(this.options.mcpAudience)}`;
    const grants = await this.call<Array<{ id: string }>>('list client grants', 'GET', `/api/v2/client-grants?${query}`);
    for (const grant of grants) {
      await this.call('delete client grant', 'DELETE', `/api/v2/client-grants/${encodeURIComponent(grant.id)}`);
    }
  }

  async restoreServiceClient(subject: string): Promise<void> {
    await this.grant(clientIdOf(subject), { alreadyGrantedIsOk: true });
  }

  private async grant(clientId: string, { alreadyGrantedIsOk = false } = {}): Promise<void> {
    await this.call(
      'create client grant',
      'POST',
      '/api/v2/client-grants',
      { client_id: clientId, audience: this.options.mcpAudience, scope: [] },
      alreadyGrantedIsOk ? [409] : [],
    );
  }

  private async call<T = unknown>(
    operation: string,
    method: string,
    path: string,
    body?: unknown,
    acceptedErrorStatuses: number[] = [],
  ): Promise<T> {
    const token = await this.managementToken();
    const response = await this.send(operation, `${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (acceptedErrorStatuses.includes(response.status)) return undefined as T;
    if (!response.ok) {
      if (response.status === 401) this.token = null;
      throw new IdentityProviderError(`identity provider: ${operation} failed (HTTP ${response.status})`);
    }
    if (response.status === 204) return undefined as T;
    return readJson<T>(response, operation);
  }

  private async managementToken(): Promise<string> {
    if (this.token && this.token.expiresAt - TOKEN_RENEW_MARGIN_MS > this.now()) return this.token.value;
    const response = await this.send('get management token', `${this.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        audience: `${this.baseUrl}/api/v2/`,
      }),
    });
    if (!response.ok) {
      throw new IdentityProviderError(`identity provider: get management token failed (HTTP ${response.status})`);
    }
    const { access_token, expires_in } = await readJson<{ access_token: string; expires_in: number }>(
      response,
      'get management token',
    );
    this.token = { value: access_token, expiresAt: this.now() + expires_in * 1000 };
    return access_token;
  }

  /** fetch with a timeout; network errors become IdentityProviderError without details. */
  private async send(operation: string, url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new IdentityProviderError(`identity provider: ${operation} failed (unreachable)`);
    }
  }
}

/** JSON.parse errors quote the body; this one does not. */
async function readJson<T>(response: Response, operation: string): Promise<T> {
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new IdentityProviderError(`identity provider: ${operation} returned an invalid response`);
  }
}

/** Subject of client_credentials tokens issued by Auth0 for a client. */
function subjectOf(clientId: string): string {
  return `${clientId}@clients`;
}

function clientIdOf(subject: string): string {
  if (!subject.endsWith('@clients')) throw new IdentityProviderError('identity provider: not a service subject');
  return subject.slice(0, -'@clients'.length);
}

/** Nobody ever knows it: long, random, and with every character class any password policy asks for. */
function randomPassword(): string {
  return `${randomBytes(32).toString('base64url')}aA1!`;
}
