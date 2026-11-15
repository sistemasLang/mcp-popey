import type { UserAdminRepository } from '../ports/outbound/user-repository.port.js';
import { generateToken, hashToken } from '../../domain/auth-token.js';
import { UserManagementError } from '../../domain/errors.js';
import type { RolePolicy } from '../../domain/role-policy.js';
import { USERNAME_PATTERN, type UserRecord } from '../../domain/user.js';

export interface ManageUsersDependencies {
  users: UserAdminRepository;
  /** Loaded lazily: disabling a user must work even if the catalog files are broken. */
  rolePolicy: () => RolePolicy;
  /** databaseKeys configured on this server (lazy, like rolePolicy). */
  databaseKeys: () => readonly string[];
  newId: () => string;
  now?: () => Date;
}

export interface IssuedToken {
  record: UserRecord;
  /** Plain token, returned once; only its SHA-256 is stored. */
  token: string;
  action: 'created' | 'rotated';
}

/**
 * Console-only user administration: create, rotate token, disable.
 * There is no HTTP path to these operations.
 */
export class ManageUsersUseCase {
  constructor(private readonly deps: ManageUsersDependencies) {}

  create(input: { username: string; role: string; databaseKey: string }): IssuedToken {
    const username = this.normalizeUsername(input.username);
    if (this.deps.users.findRecordByUsername(username)) {
      throw new UserManagementError(`user "${username}" already exists (use --rotate for a new token)`);
    }
    return this.issue({ id: this.deps.newId(), username, role: input.role, databaseKey: input.databaseKey }, 'created');
  }

  rotate(input: { username: string; role?: string; databaseKey?: string }): IssuedToken {
    const username = this.normalizeUsername(input.username);
    const existing = this.deps.users.findRecordByUsername(username);
    if (!existing) throw new UserManagementError(`user "${username}" does not exist`);
    return this.issue(
      {
        id: existing.id,
        username,
        role: input.role ?? existing.role,
        databaseKey: input.databaseKey ?? existing.databaseKey,
      },
      'rotated',
    );
  }

  disable(rawUsername: string): UserRecord {
    const username = this.normalizeUsername(rawUsername);
    const existing = this.deps.users.findRecordByUsername(username);
    if (!existing) throw new UserManagementError(`user "${username}" does not exist`);
    const disabled = { ...existing, enabled: false };
    this.deps.users.save(disabled);
    return disabled;
  }

  private issue(
    user: { id: string; username: string; role: string; databaseKey: string },
    action: IssuedToken['action'],
  ): IssuedToken {
    const rolePolicy = this.deps.rolePolicy();
    if (!rolePolicy.roles.has(user.role)) {
      const known = [...rolePolicy.roles.keys()].join(', ') || 'none defined';
      throw new UserManagementError(`role "${user.role}" is not defined in circuit-access.yaml (known: ${known})`);
    }
    const databaseKeys = this.deps.databaseKeys();
    if (!databaseKeys.includes(user.databaseKey)) {
      const known = databaseKeys.join(', ') || 'none configured';
      throw new UserManagementError(
        `database key "${user.databaseKey}" is not configured in DATABASE_KEYS (known: ${known})`,
      );
    }

    const token = generateToken();
    const record: UserRecord = {
      ...user,
      enabled: true,
      tokenSha256: hashToken(token),
      createdAt: (this.deps.now ?? (() => new Date()))().toISOString(),
    };
    this.deps.users.save(record);
    return { record, token, action };
  }

  private normalizeUsername(raw: string): string {
    const username = raw.toLowerCase();
    if (!USERNAME_PATTERN.test(username)) {
      throw new UserManagementError('--username is required: 2-64 chars [a-z0-9._-]');
    }
    return username;
  }
}
