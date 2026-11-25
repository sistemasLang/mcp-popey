import { randomBytes } from 'node:crypto';

/**
 * Auth0 Management API, with plain fetch. Only identities live in Auth0: roles,
 * tenants and admin flags never leave this server. The only file that knows Auth0.
 * Errors carry the operation and HTTP status only: never bodies, emails, secrets or links.
 */

export class Auth0Error extends Error {}

export interface PasswordLink {
  url: string;
  expiresAt: string;
}

export type Auth0 = ReturnType<typeof createAuth0>;

export function createAuth0(options: {
  domain: string;
  /** M2M app of this server for the Management API. */
  clientId: string;
  clientSecret: string;
  /** Database connection where people live. */
  connection: string;
  /** The MCP API identifier: the only audience service accounts are granted. */
  mcpAudience: string;
  passwordLinkTtlSeconds: number;
}) {
  const base = `https://${options.domain}`;
  let token: { value: string; expiresAt: number } | null = null;

  async function send(operation: string, url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new Auth0Error(`Auth0: ${operation} failed (unreachable)`);
    }
  }

  async function managementToken(): Promise<string> {
    if (token && token.expiresAt - 60_000 > Date.now()) return token.value;
    const response = await send('get management token', `${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: options.clientId,
        client_secret: options.clientSecret,
        audience: `${base}/api/v2/`,
      }),
    });
    if (!response.ok) throw new Auth0Error(`Auth0: get management token failed (HTTP ${response.status})`);
    const { access_token, expires_in } = (await response.json()) as { access_token: string; expires_in: number };
    token = { value: access_token, expiresAt: Date.now() + expires_in * 1000 };
    return access_token;
  }

  async function call<T = unknown>(operation: string, method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<T> {
    const response = await send(operation, `${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${await managementToken()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (okStatuses.includes(response.status)) return undefined as T;
    if (!response.ok) {
      if (response.status === 401) token = null;
      throw new Auth0Error(`Auth0: ${operation} failed (HTTP ${response.status})`);
    }
    const text = await response.text();
    try {
      return (text ? JSON.parse(text) : undefined) as T;
    } catch {
      throw new Auth0Error(`Auth0: ${operation} returned an invalid response`); // JSON.parse errors would quote the body
    }
  }

  const clientIdOf = (subject: string) => {
    if (!subject.endsWith('@clients')) throw new Auth0Error('Auth0: not a service subject');
    return subject.slice(0, -'@clients'.length);
  };
  const grant = (clientId: string, alreadyGrantedIsOk = false) =>
    call('create client grant', 'POST', '/api/v2/client-grants', { client_id: clientId, audience: options.mcpAudience, scope: [] }, alreadyGrantedIsOk ? [409] : []);

  return {
    issuer: `${base}/`,

    /** A person with a random password nobody knows. Sends no email: the admin hands out the password link. */
    async createHuman(email: string): Promise<string> {
      const created = await call<{ user_id: string }>('create user', 'POST', '/api/v2/users', {
        email,
        connection: options.connection,
        password: `${randomBytes(32).toString('base64url')}aA1!`,
        email_verified: false,
        verify_email: false,
      });
      return created.user_id;
    },

    async findHumanByEmail(email: string): Promise<string | null> {
      const users = await call<Array<{ user_id: string; identities?: Array<{ connection?: string }> }>>(
        'find user by email',
        'GET',
        `/api/v2/users-by-email?email=${encodeURIComponent(email)}`,
      );
      return users.find((user) => user.identities?.some((identity) => identity.connection === options.connection))?.user_id ?? null;
    },

    /** One-time URL for the person to choose a password. */
    async issuePasswordLink(subject: string): Promise<PasswordLink> {
      const issuedAt = Date.now();
      const { ticket } = await call<{ ticket: string }>('create password ticket', 'POST', '/api/v2/tickets/password-change', {
        user_id: subject,
        ttl_sec: options.passwordLinkTtlSeconds,
        mark_email_as_verified: false,
      });
      return { url: ticket, expiresAt: new Date(issuedAt + options.passwordLinkTtlSeconds * 1000).toISOString() };
    },

    async setHumanBlocked(subject: string, blocked: boolean): Promise<void> {
      await call('update user', 'PATCH', `/api/v2/users/${encodeURIComponent(subject)}`, { blocked });
    },

    /** Machine client (client_credentials) allowed only for the MCP API. */
    async createServiceClient(name: string): Promise<{ subject: string; clientId: string; clientSecret: string }> {
      const client = await call<{ client_id: string; client_secret: string }>('create client', 'POST', '/api/v2/clients', {
        name: `mcp-popey ${name}`,
        app_type: 'non_interactive',
        grant_types: ['client_credentials'],
      });
      await grant(client.client_id);
      return { subject: `${client.client_id}@clients`, clientId: client.client_id, clientSecret: client.client_secret };
    },

    async rotateServiceSecret(subject: string): Promise<{ clientId: string; clientSecret: string }> {
      const client = await call<{ client_id: string; client_secret: string }>(
        'rotate client secret',
        'POST',
        `/api/v2/clients/${encodeURIComponent(clientIdOf(subject))}/rotate-secret`,
      );
      return { clientId: client.client_id, clientSecret: client.client_secret };
    },

    /** Auth0 stops issuing MCP tokens to this client. */
    async revokeServiceClient(subject: string): Promise<void> {
      const query = `client_id=${encodeURIComponent(clientIdOf(subject))}&audience=${encodeURIComponent(options.mcpAudience)}`;
      const grants = await call<Array<{ id: string }>>('list client grants', 'GET', `/api/v2/client-grants?${query}`);
      for (const { id } of grants) await call('delete client grant', 'DELETE', `/api/v2/client-grants/${encodeURIComponent(id)}`);
    },

    async restoreServiceClient(subject: string): Promise<void> {
      await grant(clientIdOf(subject), true);
    },
  };
}
