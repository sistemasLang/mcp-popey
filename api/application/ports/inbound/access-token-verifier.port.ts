import type { ExternalIdentity } from '../../../domain/user.js';

/** Which surface the token must be issued for. A token for one never works on the other. */
export type TokenAudience = 'mcp' | 'admin';

/**
 * Bearer access token → verified `(issuer, subject)`. Throws
 * AuthenticationError for any invalid token (signature, alg, iss, aud, exp).
 * No other claim is returned: identity is all the server takes from a token.
 */
export interface AccessTokenVerifier {
  verify(token: string, audience: TokenAudience): Promise<ExternalIdentity>;
}
