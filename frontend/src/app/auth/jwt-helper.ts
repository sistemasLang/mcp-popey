export interface JwtPayload {
  exp?: number;
  sub?: string;
  aud?: string | string[];
}

/**
 * Decodes the JWT payload WITHOUT verifying the signature: for UX only
 * (e.g. "is the session about to expire"). The API verifies every token.
 * JWTs use base64url, so '-' and '_' must be mapped back before calling atob.
 */
export function decodeJwtPayload(token: string | null): JwtPayload | null {
  if (!token) return null;
  try {
    const base64Url = token.split('.')[1] ?? '';
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    return JSON.parse(atob(padded)) as JwtPayload;
  } catch {
    return null;
  }
}

export function isTokenValid(token: string | null, now = Date.now()): boolean {
  const payload = decodeJwtPayload(token);
  return !!payload?.exp && payload.exp * 1000 > now;
}
