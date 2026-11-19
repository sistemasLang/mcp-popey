import { describe, expect, it } from 'vitest';
import { Auth0IdentityProvider } from '../../api/adapters/outbound/auth0/auth0-identity-provider.adapter.js';
import { IdentityProviderError } from '../../api/domain/errors.js';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}

type Reply = { status?: number; json?: unknown; text?: string } | Error;

/** fetch double: records every request and answers from a per-route script. */
function fakeAuth0(routes: Record<string, Reply | Reply[]>) {
  const calls: Call[] = [];
  let clock = 1_000_000;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url,
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const path = new URL(url).pathname;
    const key = `${method} ${path}`;
    const scripted = routes[key] ?? (key === 'POST /oauth/token' ? { json: { access_token: 'mgmt-token', expires_in: 86_400 } } : undefined);
    if (!scripted) return new Response(null, { status: 404 });
    const reply = Array.isArray(scripted) ? (scripted.shift() ?? { status: 500 }) : scripted;
    if (reply instanceof Error) throw reply;
    const body = reply.text ?? (reply.json === undefined ? null : JSON.stringify(reply.json));
    return new Response(reply.status === 204 ? null : body, { status: reply.status ?? 200 });
  }) as typeof fetch;

  const idp = new Auth0IdentityProvider({
    domain: 'empresa.us.auth0.com',
    clientId: 'mgmt-id',
    clientSecret: 'MGMT-SECRET',
    connection: 'Username-Password-Authentication',
    mcpAudience: 'https://mcp.empresa.com/mcp',
    passwordLinkTtlSeconds: 3_600,
    fetch: fetchFn,
    now: () => clock,
  });
  return { idp, calls, advance: (ms: number) => (clock += ms) };
}

const api = (calls: Call[]) => calls.filter((call) => !call.url.endsWith('/oauth/token'));

describe('Auth0IdentityProvider', () => {
  it('issuer is https://<domain>/', () => {
    expect(fakeAuth0({}).idp.issuer).toBe('https://empresa.us.auth0.com/');
  });

  it('gets a Management API token with client_credentials and caches it until it nears expiry', async () => {
    const { idp, calls, advance } = fakeAuth0({ 'PATCH /api/v2/users/auth0%7Cabc': { status: 200, json: {} } });
    await idp.setHumanBlocked('auth0|abc', true);
    await idp.setHumanBlocked('auth0|abc', false);
    const tokenCalls = calls.filter((call) => call.url.endsWith('/oauth/token'));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.body).toEqual({
      grant_type: 'client_credentials',
      client_id: 'mgmt-id',
      client_secret: 'MGMT-SECRET',
      audience: 'https://empresa.us.auth0.com/api/v2/',
    });
    expect(api(calls)[0]?.headers.authorization).toBe('Bearer mgmt-token');

    advance(86_400_000);
    await idp.setHumanBlocked('auth0|abc', true);
    expect(calls.filter((call) => call.url.endsWith('/oauth/token'))).toHaveLength(2);
  });

  it('createHuman: random password nobody knows, no email of any kind', async () => {
    const { idp, calls } = fakeAuth0({ 'POST /api/v2/users': { status: 201, json: { user_id: 'auth0|new' } } });
    await expect(idp.createHuman('juan@empresa.com')).resolves.toEqual({ subject: 'auth0|new' });
    const [create] = api(calls);
    expect(create?.body).toMatchObject({
      email: 'juan@empresa.com',
      connection: 'Username-Password-Authentication',
      email_verified: false,
      verify_email: false,
    });
    expect(create?.body.password).toMatch(/^[A-Za-z0-9_-]{43}aA1!$/);
  });

  it('issuePasswordLink: password-change ticket with ttl, email not marked verified; returns URL and expiry', async () => {
    const ticket = 'https://empresa.us.auth0.com/u/reset-verify?ticket=XYZ#';
    const { idp, calls } = fakeAuth0({ 'POST /api/v2/tickets/password-change': { status: 201, json: { ticket } } });
    const link = await idp.issuePasswordLink('auth0|abc');
    expect(link).toEqual({ url: ticket, expiresAt: new Date(1_000_000 + 3_600_000) });
    expect(api(calls)[0]?.body).toEqual({ user_id: 'auth0|abc', ttl_sec: 3_600, mark_email_as_verified: false });
  });

  it('findHumanByEmail: only users of the configured database connection', async () => {
    const { idp, calls } = fakeAuth0({
      'GET /api/v2/users-by-email': [
        { json: [{ user_id: 'google-oauth2|1', identities: [{ connection: 'google-oauth2' }] }, { user_id: 'auth0|2', identities: [{ connection: 'Username-Password-Authentication' }] }] },
        { json: [] },
      ],
    });
    await expect(idp.findHumanByEmail('a+b@empresa.com')).resolves.toEqual({ subject: 'auth0|2' });
    await expect(idp.findHumanByEmail('nadie@empresa.com')).resolves.toBeNull();
    expect(api(calls)[0]?.url).toBe('https://empresa.us.auth0.com/api/v2/users-by-email?email=a%2Bb%40empresa.com');
  });

  it('createServiceClient: non_interactive app with client_credentials, granted only to the MCP audience', async () => {
    const { idp, calls } = fakeAuth0({
      'POST /api/v2/clients': { status: 201, json: { client_id: 'cid', client_secret: 'CLIENT-SECRET' } },
      'POST /api/v2/client-grants': { status: 201, json: { id: 'cgr_1' } },
    });
    await expect(idp.createServiceClient('n8n')).resolves.toEqual({
      subject: 'cid@clients',
      clientId: 'cid',
      clientSecret: 'CLIENT-SECRET',
    });
    const [client, grant] = api(calls);
    expect(client?.body).toEqual({ name: 'mcp-popey n8n', app_type: 'non_interactive', grant_types: ['client_credentials'] });
    expect(grant?.body).toEqual({ client_id: 'cid', audience: 'https://mcp.empresa.com/mcp', scope: [] });
  });

  it('revokeServiceClient deletes the grants for the MCP audience; restore re-creates it and tolerates 409', async () => {
    const { idp, calls } = fakeAuth0({
      'GET /api/v2/client-grants': { json: [{ id: 'cgr_1' }] },
      'DELETE /api/v2/client-grants/cgr_1': { status: 204 },
      'POST /api/v2/client-grants': { status: 409, json: { message: 'already exists' } },
    });
    await idp.revokeServiceClient('cid@clients');
    await idp.restoreServiceClient('cid@clients');
    const urls = api(calls).map((call) => `${call.method} ${call.url}`);
    expect(urls).toEqual([
      'GET https://empresa.us.auth0.com/api/v2/client-grants?client_id=cid&audience=https%3A%2F%2Fmcp.empresa.com%2Fmcp',
      'DELETE https://empresa.us.auth0.com/api/v2/client-grants/cgr_1',
      'POST https://empresa.us.auth0.com/api/v2/client-grants',
    ]);
  });

  it('rotateServiceSecret uses the client id from the subject', async () => {
    const { idp, calls } = fakeAuth0({ 'POST /api/v2/clients/cid/rotate-secret': { json: { client_id: 'cid', client_secret: 'NEW' } } });
    await expect(idp.rotateServiceSecret('cid@clients')).resolves.toEqual({ clientId: 'cid', clientSecret: 'NEW' });
    expect(api(calls)).toHaveLength(1);
    await expect(idp.rotateServiceSecret('auth0|person')).rejects.toThrow(IdentityProviderError);
  });

  it.each<[string, Reply]>([
    ['HTTP error with a body', { status: 400, json: { message: 'juan@empresa.com MGMT-SECRET details' } }],
    ['invalid JSON', { status: 200, text: '<html>juan@empresa.com MGMT-SECRET</html>' }],
    ['network failure', new Error('getaddrinfo ENOTFOUND MGMT-SECRET juan@empresa.com')],
  ])('%s → IdentityProviderError without body, credentials, email or ticket', async (_case, reply) => {
    const { idp } = fakeAuth0({ 'POST /api/v2/tickets/password-change': reply, 'GET /api/v2/users-by-email': reply });
    for (const call of [() => idp.issuePasswordLink('auth0|abc'), () => idp.findHumanByEmail('juan@empresa.com')]) {
      const error = await call().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(IdentityProviderError);
      expect(String((error as Error).message)).not.toMatch(/MGMT-SECRET|juan@empresa|html|mgmt-token|ticket=/);
    }
  });

  it('a rejected Management API token is not reused', async () => {
    const { idp, calls } = fakeAuth0({ 'PATCH /api/v2/users/auth0%7Cabc': [{ status: 401 }, { status: 200, json: {} }] });
    await expect(idp.setHumanBlocked('auth0|abc', true)).rejects.toThrow(IdentityProviderError);
    await idp.setHumanBlocked('auth0|abc', true);
    expect(calls.filter((call) => call.url.endsWith('/oauth/token'))).toHaveLength(2);
  });
});
