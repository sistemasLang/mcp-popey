import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { ConfigurationError } from '../errors/app-errors.js';
import type { User, UserRecord } from './user.model.js';

export interface UserRepository {
  findById(id: string): Promise<User | null>;
  /** Resolves a token hash to a user id. Disabled users are still returned; callers check `enabled`. */
  findIdByTokenHash(tokenSha256: string): Promise<string | null>;
}

const UserRecordSchema = z
  .object({
    id: z.string().min(1),
    username: z.string().min(1),
    role: z.string().min(1),
    databaseKey: z.string().min(1),
    enabled: z.boolean(),
    tokenSha256: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.string(),
  })
  .strict();

const UsersFileSchema = z.object({ users: z.array(UserRecordSchema).nullish() }).strict();

function toUser(record: UserRecord): User {
  return {
    id: record.id,
    username: record.username,
    role: record.role,
    databaseKey: record.databaseKey,
    enabled: record.enabled,
  };
}

function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * users.yaml-backed repository. Re-reads the file when its mtime changes, so
 * creating or disabling a user with the CLI needs no server restart.
 */
export class YamlUserRepository implements UserRepository {
  private records: UserRecord[] = [];
  private loadedMtimeMs: number | null = null;

  constructor(private readonly path: string) {}

  async findById(id: string): Promise<User | null> {
    const record = this.current().find((candidate) => candidate.id === id);
    return record ? toUser(record) : null;
  }

  async findIdByTokenHash(tokenSha256: string): Promise<string | null> {
    // Compare against every record (no early exit) to keep timing uniform.
    let match: string | null = null;
    for (const record of this.current()) {
      if (hashesMatch(record.tokenSha256, tokenSha256)) match = record.id;
    }
    return match;
  }

  // --- Used by the CLI only ---

  findRecordByUsername(username: string): UserRecord | undefined {
    return this.current().find((record) => record.username === username);
  }

  save(record: UserRecord): void {
    const records = this.current().filter((existing) => existing.id !== record.id);
    records.push(record);
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    writeFileSync(temporaryPath, stringify({ users: records }), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, this.path);
    chmodSync(this.path, 0o600);
    this.loadedMtimeMs = null;
  }

  private current(): UserRecord[] {
    if (!existsSync(this.path)) {
      this.records = [];
      this.loadedMtimeMs = null;
      return this.records;
    }
    const mtimeMs = statSync(this.path).mtimeMs;
    if (mtimeMs === this.loadedMtimeMs) return this.records;

    const result = UsersFileSchema.safeParse(parse(readFileSync(this.path, 'utf8')));
    if (!result.success) {
      throw new ConfigurationError(`Invalid users file ${this.path}:\n${z.prettifyError(result.error)}`);
    }
    this.records = result.data.users ?? [];
    this.loadedMtimeMs = mtimeMs;
    return this.records;
  }
}

/** Test/in-process repository. */
export class InMemoryUserRepository implements UserRepository {
  constructor(private readonly records: UserRecord[]) {}

  async findById(id: string): Promise<User | null> {
    const record = this.records.find((candidate) => candidate.id === id);
    return record ? toUser(record) : null;
  }

  async findIdByTokenHash(tokenSha256: string): Promise<string | null> {
    let match: string | null = null;
    for (const record of this.records) {
      if (hashesMatch(record.tokenSha256, tokenSha256)) match = record.id;
    }
    return match;
  }
}
