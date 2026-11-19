import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AccessTokenVerifier, TokenAudience } from '../../../application/ports/inbound/access-token-verifier.port.js';
import { AuthenticationError } from '../../../domain/errors.js';
import type { ExternalIdentity } from '../../../domain/user.js';

export interface JwtVerifierOptions {
  /** Exact `iss`, e.g. `https://empresa.us.auth0.com/`. */
  issuer: string;
  /** Required `aud` per surface; they must differ so tokens cannot be replayed across them. */
  audiences: Record<TokenAudience, string>;
  /** Signing keys; defaults to the issuer's remote JWKS (cached by jose). Tests pass a local set. */
  keys?: JWTVerifyGetKey;
}

const CLOCK_TOLERANCE_SECONDS = 30;

/**
 * Local JWT verification (no call to the IdP per request): RS256 only, exact
 * issuer, audience of the surface, exp/nbf with 30 s tolerance and a `sub`.
 * Only `(iss, sub)` leaves this class; every other claim is ignored.
 */
export class JwtAccessTokenVerifier implements AccessTokenVerifier {
  private readonly keys: JWTVerifyGetKey;

  constructor(private readonly options: JwtVerifierOptions) {
    if (options.audiences.mcp === options.audiences.admin) {
      throw new Error('the MCP and admin audiences must be different');
    }
    this.keys = options.keys ?? createRemoteJWKSet(new URL('.well-known/jwks.json', options.issuer));
  }

  async verify(token: string, audience: TokenAudience): Promise<ExternalIdentity> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        algorithms: ['RS256'],
        issuer: this.options.issuer,
        audience: this.options.audiences[audience],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ['sub', 'exp'],
      });
      if (typeof payload.sub !== 'string' || payload.sub === '') throw new AuthenticationError('Invalid access token');
      return { issuer: this.options.issuer, subject: payload.sub };
    } catch (error) {
      if (error instanceof errors.JOSEError || error instanceof AuthenticationError) {
        throw new AuthenticationError('Invalid access token');
      }
      throw error;
    }
  }
}
