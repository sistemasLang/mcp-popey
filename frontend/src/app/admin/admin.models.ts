export type UserKind = 'human' | 'service';

/** As returned by GET /admin/api/users: no IdP identities. */
export interface AdminUser {
  id: string;
  kind: UserKind;
  label: string;
  admin: boolean;
  role: string | null;
  databaseKey: string | null;
  enabled: boolean;
  createdAt: string;
}

export interface Catalog {
  roles: string[];
  databaseKeys: string[];
}

export interface PasswordLink {
  url: string;
  expiresAt: string;
}

export interface InviteRequest {
  email: string;
  admin?: boolean;
  role?: string;
  databaseKey?: string;
}

export interface InviteResponse {
  user: AdminUser;
  passwordLink: PasswordLink | null;
  passwordLinkError?: string;
}

/** `null` role + databaseKey removes /mcp access. They always travel together. */
export interface UserPatch {
  admin?: boolean;
  enabled?: boolean;
  role?: string | null;
  databaseKey?: string | null;
}

export interface UpdateResponse {
  user: AdminUser;
  warning?: string;
}

export interface ServiceAccountRequest {
  name: string;
  role: string;
  databaseKey: string;
}

export interface ServiceCredentials {
  clientId: string;
  clientSecret: string;
}

export interface ServiceAccountResponse extends ServiceCredentials {
  user: AdminUser;
}

/** Something shown once (password link or client secret) and never stored. */
export interface OneTimeValue {
  title: string;
  value: string;
  detail?: string;
  expiresAt?: string;
}
