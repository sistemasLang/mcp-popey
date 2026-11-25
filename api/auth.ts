import type { IncomingMessage } from 'node:http';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { UserRecord, UserStore } from './users.js';

/**
 * Who is calling. Two steps, kept apart on purpose:
 *   1. Identity: the Auth0 JWT proves `(iss, sub)`. No other claim is trusted.
 *   2. Authorization: role, tenant (databaseKey), admin and enabled live only in users.yaml.
 */

/** The two surfaces. Each requires its own token audience, so a token for one is useless on the other. */
export type Surface = 'mcp' | 'admin';

/** The caller of one /mcp request. Built server-side; tools never take it from their input. */
export interface User {
  id: string;
  kind: 'human' | 'service';
  role: string;
  databaseKey: string;
}

/** `Authorization: Bearer <token>` → token, or null. */
export function bearerToken(request: IncomingMessage): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.authorization ?? '');
  return match?.[1] ?? null;
}

/**
 * Verifies a JWT locally against the issuer's JWKS (cached by jose, no call to Auth0
 * per request): RS256 only, exact issuer, the surface's audience, 30 s clock
 * tolerance. Returns the subject, or null for any invalid token.
 */
export function createTokenVerifier(options: { issuer: string; audiences: Record<Surface, string>; keys?: JWTVerifyGetKey }) {
  if (options.audiences.mcp === options.audiences.admin) throw new Error('the MCP and admin audiences must be different');
  const keys = options.keys ?? createRemoteJWKSet(new URL('.well-known/jwks.json', options.issuer));
  return async (token: string, surface: Surface): Promise<string | null> => {
    try {
      const { payload } = await jwtVerify(token, keys, {
        algorithms: ['RS256'],
        issuer: options.issuer,
        audience: options.audiences[surface],
        clockTolerance: 30,
        requiredClaims: ['sub', 'exp'],
      });
      return payload.sub || null;
    } catch {
      return null;
    }
  };
}

/** /mcp: an enabled user with role + databaseKey. Anything else is null (→ 403). */
export function mcpUser(users: UserStore, issuer: string, subject: string): User | null {
  const user = users.findByIdentity(issuer, subject);
  if (!user?.enabled || !user.role || !user.databaseKey) return null;
  return { id: user.id, kind: user.kind, role: user.role, databaseKey: user.databaseKey };
}

/** /admin/api: an enabled person with admin: true. Role is irrelevant here. */
export function adminUser(users: UserStore, issuer: string, subject: string): UserRecord | null {
  const user = users.findByIdentity(issuer, subject);
  return user?.enabled && user.kind === 'human' && user.admin ? user : null;
}
