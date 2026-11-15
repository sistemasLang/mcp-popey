import type { User, UserRecord } from '../../../domain/user.js';

/** Read side used on every request (authentication). */
export interface UserRepository {
  findById(id: string): Promise<User | null>;
  /** Resolves a token hash to a user id. Disabled users are still returned; callers check `enabled`. */
  findIdByTokenHash(tokenSha256: string): Promise<string | null>;
}

/** Write side, used only by the user-management CLI. */
export interface UserAdminRepository {
  findRecordByUsername(username: string): UserRecord | undefined;
  save(record: UserRecord): void;
}
