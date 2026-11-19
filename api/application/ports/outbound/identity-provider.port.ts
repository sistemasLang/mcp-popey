/**
 * What the application needs from the identity provider (Auth0 today). Only
 * identities live there: roles, tenants and admin flags never leave this
 * server. Every method throws IdentityProviderError on failure.
 */
export interface IdentityProviderPort {
  /** Issuer of the tokens this provider signs; stored with every identity. */
  readonly issuer: string;

  /** Creates a person with a random password nobody knows. Sends no email. */
  createHuman(email: string): Promise<{ subject: string }>;
  /** One-time URL for the person to choose a password. Sends no email; the admin delivers it. */
  issuePasswordLink(subject: string): Promise<PasswordLink>;
  findHumanByEmail(email: string): Promise<{ subject: string } | null>;
  setHumanBlocked(subject: string, blocked: boolean): Promise<void>;

  /** Machine client (client_credentials) allowed only for the MCP resource. */
  createServiceClient(name: string): Promise<ServiceCredentials & { subject: string }>;
  rotateServiceSecret(subject: string): Promise<ServiceCredentials>;
  /** The provider stops issuing tokens for the MCP resource to this client. */
  revokeServiceClient(subject: string): Promise<void>;
  /** Undoes revokeServiceClient. */
  restoreServiceClient(subject: string): Promise<void>;
}

export interface PasswordLink {
  url: string;
  expiresAt: Date;
}

export interface ServiceCredentials {
  clientId: string;
  /** Returned once; never persisted, logged or audited. */
  clientSecret: string;
}
