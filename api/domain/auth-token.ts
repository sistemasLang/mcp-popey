import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Shape of every token generateToken() produces; anything else is rejected early. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

/**
 * Tokens are random 256-bit values (not human passwords), so an unsalted
 * SHA-256 is enough: there is no dictionary to try.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 256-bit random opaque token. Only its SHA-256 is ever stored. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time comparison of two hex SHA-256 digests. */
export function tokenHashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
