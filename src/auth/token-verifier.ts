import { createHash, randomBytes } from 'node:crypto';
import { AuthenticationError } from '../errors/app-errors.js';
import type { UserRepository } from '../users/user.repository.js';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 256-bit random opaque token. Only its SHA-256 is ever stored. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Bearer token → user id. Tokens are random 256-bit values (not human
 * passwords), so an unsalted SHA-256 is enough: there is no dictionary to try.
 */
export class TokenVerifier {
  constructor(private readonly users: UserRepository) {}

  async verify(token: string): Promise<string> {
    if (!TOKEN_PATTERN.test(token)) throw new AuthenticationError('Invalid bearer token');
    const userId = await this.users.findIdByTokenHash(hashToken(token));
    if (!userId) throw new AuthenticationError('Invalid bearer token');
    return userId;
  }
}
