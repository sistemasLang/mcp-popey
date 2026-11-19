import { Injectable, inject } from '@angular/core';
import { OAuthService } from 'angular-oauth2-oidc';
import { APP_CONFIG } from '../core/app-config';

/**
 * Login is a redirect to Auth0 (authorization code + PKCE): the password
 * never goes through the panel. The access token is for ADMIN_API_AUDIENCE
 * only, so it is useless against /mcp. Whether the user is an admin is
 * decided by the API, never by this service.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly oauth = inject(OAuthService);
  private readonly config = inject(APP_CONFIG);

  /** Processes the redirect back from Auth0, if any. Runs once at startup. */
  async init(): Promise<void> {
    this.oauth.configure({
      issuer: this.config.issuer,
      clientId: this.config.clientId,
      responseType: 'code',
      redirectUri: document.baseURI,
      postLogoutRedirectUri: document.baseURI,
      scope: 'openid profile email',
      customQueryParams: { audience: this.config.audience },
      clearHashAfterLogin: true,
      sessionChecksEnabled: false,
      showDebugInformation: false,
    });
    await this.oauth.loadDiscoveryDocumentAndTryLogin();
  }

  isLoggedIn(): boolean {
    return this.oauth.hasValidAccessToken();
  }

  login(): void {
    this.oauth.initCodeFlow();
  }

  logout(): void {
    this.oauth.logOut();
  }

  getToken(): string | null {
    return this.isLoggedIn() ? this.oauth.getAccessToken() : null;
  }

  /** For display only. */
  userLabel(): string | null {
    const claims = this.oauth.getIdentityClaims() as { email?: string; name?: string } | null;
    return claims?.email ?? claims?.name ?? null;
  }
}
