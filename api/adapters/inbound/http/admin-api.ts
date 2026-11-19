import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { AccessTokenVerifier } from '../../../application/ports/inbound/access-token-verifier.port.js';
import type { AdminAction } from '../../../application/ports/outbound/audit-log.port.js';
import type { PasswordLink } from '../../../application/ports/outbound/identity-provider.port.js';
import type { InternalErrorLogger } from '../../../application/ports/outbound/internal-error-log.port.js';
import type { AdminUsersUseCase } from '../../../application/use-cases/admin-users.use-case.js';
import type { AuthenticateUserUseCase } from '../../../application/use-cases/authenticate-user.use-case.js';
import {
  AuthenticationError,
  ForbiddenError,
  IdentityProviderError,
  UserConflictError,
  UserManagementError,
  UserNotFoundError,
} from '../../../domain/errors.js';
import type { User } from '../../../domain/user.js';
import { bearerToken } from './bearer-token.js';

export const ADMIN_API_PREFIX = '/admin/api/';
const MAX_BODY_BYTES = 16 * 1024;

export interface AdminApiDependencies {
  tokens: AccessTokenVerifier;
  authenticateUser: AuthenticateUserUseCase;
  adminUsers: AdminUsersUseCase;
  logInternalError: InternalErrorLogger;
}

const Name = z.string().min(1).max(64);

const InviteSchema = z
  .object({ email: z.string().max(254), admin: z.boolean().optional(), role: Name.optional(), databaseKey: Name.optional() })
  .strict();

const UpdateSchema = z
  .object({
    admin: z.boolean().optional(),
    enabled: z.boolean().optional(),
    role: Name.nullable().optional(),
    databaseKey: Name.nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'at least one field is required');

const ServiceAccountSchema = z.object({ name: z.string().max(64), role: Name, databaseKey: Name }).strict();

const EmptySchema = z.object({}).strict().optional();

interface RouteContext {
  actor: User;
  id: string;
  body: unknown;
}

interface Route {
  method: 'GET' | 'POST' | 'PATCH';
  pattern: RegExp;
  /** Writes only: what to audit when the body is rejected here. */
  action?: AdminAction;
  schema?: z.ZodType;
  handle: (context: RouteContext, deps: AdminApiDependencies) => Promise<{ status: number; body: unknown }>;
}

const ID = '([A-Za-z0-9-]{1,64})';

const ROUTES: Route[] = [
  {
    method: 'GET',
    pattern: /^catalog$/,
    handle: async (_context, deps) => ({ status: 200, body: deps.adminUsers.catalog() }),
  },
  {
    method: 'GET',
    pattern: /^users$/,
    handle: async (_context, deps) => ({ status: 200, body: { users: await deps.adminUsers.list() } }),
  },
  {
    method: 'POST',
    pattern: /^users$/,
    action: 'invite_user',
    schema: InviteSchema,
    handle: async ({ actor, body }, deps) => {
      const result = await deps.adminUsers.invite(actor, body as z.infer<typeof InviteSchema>);
      return {
        status: 201,
        body: {
          user: result.user,
          passwordLink: result.passwordLink && linkJson(result.passwordLink),
          ...(result.passwordLink ? {} : { passwordLinkError: 'IDENTITY_PROVIDER_ERROR' }),
        },
      };
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^users/${ID}/password-link$`),
    action: 'issue_password_link',
    schema: EmptySchema,
    handle: async ({ actor, id }, deps) => {
      const { passwordLink } = await deps.adminUsers.issuePasswordLink(actor, id);
      return { status: 200, body: { passwordLink: linkJson(passwordLink) } };
    },
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^users/${ID}$`),
    action: 'update_user',
    schema: UpdateSchema,
    handle: async ({ actor, id, body }, deps) => {
      const result = await deps.adminUsers.update(actor, id, body as z.infer<typeof UpdateSchema>);
      return {
        status: 200,
        body: { user: result.user, ...(result.identityProviderSynced ? {} : { warning: 'IDENTITY_PROVIDER_SYNC_FAILED' }) },
      };
    },
  },
  {
    method: 'POST',
    pattern: /^service-accounts$/,
    action: 'create_service_account',
    schema: ServiceAccountSchema,
    handle: async ({ actor, body }, deps) => ({
      status: 201,
      body: await deps.adminUsers.createServiceAccount(actor, body as z.infer<typeof ServiceAccountSchema>),
    }),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^service-accounts/${ID}/rotate-secret$`),
    action: 'rotate_service_secret',
    schema: EmptySchema,
    handle: async ({ actor, id }, deps) => ({ status: 200, body: await deps.adminUsers.rotateServiceSecret(actor, id) }),
  },
];

/**
 * /admin/api/*: admin-audience JWT → enabled human admin → route. Bodies are
 * strict Zod schemas. Responses never carry IdP identities; a fresh secret or
 * password link is returned once, with Cache-Control: no-store (set on every
 * response). No cookies, so no CSRF; same origin as the panel, so no CORS.
 */
export async function handleAdminApi(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  deps: AdminApiDependencies,
): Promise<void> {
  let actor: User;
  try {
    actor = await deps.authenticateUser.authenticateAdmin(await deps.tokens.verify(bearerToken(request), 'admin'));
  } catch (error) {
    if (error instanceof AuthenticationError) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      return writeError(response, 401, 'UNAUTHORIZED', 'Unauthorized');
    }
    if (error instanceof ForbiddenError) return writeError(response, 403, 'FORBIDDEN', 'Forbidden');
    throw error;
  }

  const relative = path.slice(ADMIN_API_PREFIX.length);
  const matching = ROUTES.filter((route) => route.pattern.test(relative));
  if (matching.length === 0) return writeError(response, 404, 'NOT_FOUND', 'Not found');
  const route = matching.find((candidate) => candidate.method === request.method);
  if (!route) {
    response.setHeader('Allow', matching.map((candidate) => candidate.method).join(', '));
    return writeError(response, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }
  const id = route.pattern.exec(relative)?.[1] ?? '';

  let body: unknown;
  if (route.schema) {
    const parsed = await readBody(request).then(
      (raw) => route.schema!.safeParse(raw),
      (error: unknown) => ({ success: false as const, error }),
    );
    if (!parsed.success) {
      deps.adminUsers.auditRejected(actor, route.action!, 'INVALID_REQUEST', id || undefined);
      const message = parsed.error instanceof z.ZodError ? z.prettifyError(parsed.error) : 'Invalid JSON body';
      return writeError(response, parsed.error instanceof BodyTooLargeError ? 413 : 400, 'INVALID_REQUEST', message);
    }
    body = parsed.data;
  }

  try {
    const result = await route.handle({ actor, id, body }, deps);
    writeJson(response, result.status, result.body);
  } catch (error) {
    writeUseCaseError(response, error, deps.logInternalError);
  }
}

function writeUseCaseError(response: ServerResponse, error: unknown, logInternalError: InternalErrorLogger): void {
  if (error instanceof UserNotFoundError) return writeError(response, 404, error.code, error.message);
  if (error instanceof UserConflictError) return writeError(response, 409, error.code, error.message);
  if (error instanceof UserManagementError) return writeError(response, 400, error.code, error.message);
  if (error instanceof IdentityProviderError) {
    logInternalError(error);
    return writeError(response, 502, error.code, 'The identity provider failed; try again');
  }
  logInternalError(error);
  writeError(response, 500, 'INTERNAL_ERROR', 'An internal error occurred');
}

class BodyTooLargeError extends Error {}

/** Empty body → undefined. Throws on invalid JSON or more than MAX_BODY_BYTES. */
async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError('body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text === '' ? undefined : JSON.parse(text);
}

function linkJson(link: PasswordLink): { url: string; expiresAt: string } {
  return { url: link.url, expiresAt: link.expiresAt.toISOString() };
}

function writeError(response: ServerResponse, status: number, code: string, message: string): void {
  writeJson(response, status, { error: { code, message } });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response
    .writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    .end(JSON.stringify(body));
}
