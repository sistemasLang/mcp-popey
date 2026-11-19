import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import type { UserAdminRepository, UserRepository } from '../../../application/ports/outbound/user-repository.port.js';
import { AppError, ConfigurationError } from '../../../domain/errors.js';
import { assertUniqueIdentities, assertValidUser, type User } from '../../../domain/user.js';

const IdentitySchema = z.object({ issuer: z.string().min(1), subject: z.string().min(1) }).strict();

const UserSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['human', 'service']),
    label: z.string().min(1),
    admin: z.boolean(),
    role: z.string().min(1).optional(),
    databaseKey: z.string().min(1).optional(),
    enabled: z.boolean(),
    identities: z.array(IdentitySchema).min(1),
    createdAt: z.string(),
  })
  .strict();

const UsersFileSchema = z.object({ version: z.literal(2), users: z.array(UserSchema).nullish() }).strict();

/**
 * users.yaml (format v2) repository. Re-reads the file when its mtime
 * changes, so admin API writes and manual edits apply without a restart.
 * Writes are atomic (temp file + rename) with mode 0600. A v1 file (static
 * token hashes) is refused instead of being read as empty or valid.
 */
export class YamlUserRepository implements UserRepository, UserAdminRepository {
  private users: User[] = [];
  private loadedMtimeMs: number | null = null;

  constructor(private readonly path: string) {}

  async findByIdentity(issuer: string, subject: string): Promise<User | null> {
    return copy(
      this.current().find((user) =>
        user.identities.some((identity) => identity.issuer === issuer && identity.subject === subject),
      ),
    );
  }

  async findById(id: string): Promise<User | null> {
    return copy(this.current().find((user) => user.id === id));
  }

  async findByLabel(label: string): Promise<User | null> {
    return copy(this.current().find((user) => user.label === label));
  }

  async list(): Promise<User[]> {
    return this.current().map((user) => structuredClone(user));
  }

  async countEnabledAdmins(): Promise<number> {
    return this.current().filter((user) => user.admin && user.enabled).length;
  }

  async save(user: User): Promise<void> {
    assertValidUser(user);
    const users = [...this.current().filter((existing) => existing.id !== user.id), structuredClone(user)];
    assertUniqueIdentities(users);

    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    writeFileSync(temporaryPath, stringify({ version: 2, users }), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, this.path);
    chmodSync(this.path, 0o600);
    this.loadedMtimeMs = null;
  }

  private current(): User[] {
    if (!existsSync(this.path)) {
      this.users = [];
      this.loadedMtimeMs = null;
      return this.users;
    }
    const mtimeMs = statSync(this.path).mtimeMs;
    if (mtimeMs === this.loadedMtimeMs) return this.users;

    const raw: unknown = parse(readFileSync(this.path, 'utf8'));
    if (raw === null || raw === undefined) {
      this.users = [];
    } else {
      if (isV1(raw)) {
        throw new ConfigurationError(
          `${this.path} is in the old format (static tokens, v1). Move it aside (e.g. to users.v1.yaml.bak) ` +
            'and restart: admins come back through BOOTSTRAP_ADMIN_EMAILS and everyone else is invited from the panel',
        );
      }
      const result = UsersFileSchema.safeParse(raw);
      if (!result.success) {
        throw new ConfigurationError(`Invalid users file ${this.path}:\n${z.prettifyError(result.error)}`);
      }
      const users = (result.data.users ?? []) as User[];
      try {
        users.forEach(assertValidUser);
        assertUniqueIdentities(users);
      } catch (error) {
        if (error instanceof AppError) throw new ConfigurationError(`Invalid users file ${this.path}: ${error.message}`);
        throw error;
      }
      this.users = users;
    }
    this.loadedMtimeMs = mtimeMs;
    return this.users;
  }
}

function isV1(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const file = raw as { version?: unknown; users?: unknown };
  if (file.version === undefined) return true;
  return Array.isArray(file.users) && file.users.some((user) => typeof user === 'object' && user !== null && 'tokenSha256' in user);
}

/** Callers get copies: mutating a result never changes the cache. */
function copy(user: User | undefined): User | null {
  return user ? structuredClone(user) : null;
}
