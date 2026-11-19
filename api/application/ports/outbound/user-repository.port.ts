import type { User } from '../../../domain/user.js';

/** Read side used on every request (authentication) and by the admin listing. */
export interface UserRepository {
  /** Disabled users are still returned; callers check `enabled`. */
  findByIdentity(issuer: string, subject: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  list(): Promise<User[]>;
}

/** Write side, used by the admin use cases and the admin bootstrap. */
export interface UserAdminRepository {
  /** Inserts or replaces by `id`. Rejects an identity already linked to another user. */
  save(user: User): Promise<void>;
  findByLabel(label: string): Promise<User | null>;
  countEnabledAdmins(): Promise<number>;
}
