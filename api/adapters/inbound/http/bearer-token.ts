import type { IncomingMessage } from 'node:http';
import { AuthenticationError } from '../../../domain/errors.js';

/** `Authorization: Bearer <token>` → token. Throws AuthenticationError if absent or malformed. */
export function bearerToken(request: Pick<IncomingMessage, 'headers'>): string {
  const header = request.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  if (!match?.[1]) throw new AuthenticationError('Missing bearer token');
  return match[1];
}
