import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { ConfigError } from './errors.js';

/**
 * users.yaml (format v2): who has access and with what. Auth0 only proves the
 * identity `(issuer, subject)`; role, tenant (databaseKey), admin and enabled
 * live here. Written by the admin panel (/admin/api) and editable by hand: the
 * file is re-read whenever its mtime changes.
 */

const UserSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['human', 'service']),
    /** Email of a person or name of a service account. For display and lookups, never for authorization. */
    label: z.string().min(1),
    admin: z.boolean(),
    enabled: z.boolean(),
    role: z.string().min(1).optional(),
    databaseKey: z.string().min(1).optional(),
    identities: z.array(z.object({ issuer: z.string().min(1), subject: z.string().min(1) }).strict()).min(1),
    createdAt: z.string(),
  })
  .strict();

const UsersFileSchema = z.object({ version: z.literal(2), users: z.array(UserSchema).nullish() }).strict();

export type UserRecord = z.infer<typeof UserSchema>;

/** What the admin panel sees of a user: no identities. */
export function toView(user: UserRecord) {
  const { id, kind, label, admin, enabled, createdAt } = user;
  return { id, kind, label, admin, role: user.role ?? null, databaseKey: user.databaseKey ?? null, enabled, createdAt };
}

/** A user (or the whole file) breaks a rule. Its message is safe to show to an admin. */
export class InvalidUserError extends Error {}

/** Rules every saved file must meet. */
function check(users: UserRecord[]): void {
  const seen = new Map<string, string>();
  for (const user of users) {
    if ((user.role === undefined) !== (user.databaseKey === undefined)) {
      throw new InvalidUserError(`user "${user.id}": role and databaseKey must be set together or not at all`);
    }
    if (user.kind === 'service' && user.admin) throw new InvalidUserError(`user "${user.id}": a service account cannot be an admin`);
    for (const identity of user.identities) {
      // An identity pointing to two users would make access ambiguous.
      const key = `${identity.issuer} ${identity.subject}`;
      if (seen.has(key) && seen.get(key) !== user.id) throw new InvalidUserError("an identity is linked to more than one user");
      seen.set(key, user.id);
    }
  }
}

export type UserStore = ReturnType<typeof createUserStore>;

export function createUserStore(path: string) {
  let cache: UserRecord[] = [];
  let loadedMtime: number | null = null;

  function all(): UserRecord[] {
    if (!existsSync(path)) return [];
    const mtime = statSync(path).mtimeMs;
    if (mtime === loadedMtime) return cache;

    const raw = parse(readFileSync(path, 'utf8')) ?? { version: 2 };
    const result = UsersFileSchema.safeParse(raw);
    if (!result.success) throw new ConfigError(`Invalid users file ${path}:\n${z.prettifyError(result.error)}`);
    const users = result.data.users ?? [];
    try {
      check(users);
    } catch (error) {
      throw new ConfigError(`Invalid users file ${path}: ${(error as Error).message}`);
    }
    cache = users;
    loadedMtime = mtime;
    return cache;
  }

  return {
    /** Everyone, as copies (mutating a result never changes the cache). */
    list: (): UserRecord[] => structuredClone(all()),
    findById: (id: string) => structuredClone(all().find((user) => user.id === id) ?? null),
    findByLabel: (label: string) => structuredClone(all().find((user) => user.label === label) ?? null),
    findByIdentity: (issuer: string, subject: string) =>
      structuredClone(
        all().find((user) => user.identities.some((identity) => identity.issuer === issuer && identity.subject === subject)) ??
          null,
      ),
    countEnabledAdmins: () => all().filter((user) => user.admin && user.enabled).length,

    /** Inserts or replaces by id. Atomic (temp file + rename), mode 0600. */
    save(user: UserRecord): void {
      const users = [...all().filter((existing) => existing.id !== user.id), structuredClone(user)];
      check(users);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, stringify({ version: 2, users }), { encoding: 'utf8', mode: 0o600 });
      renameSync(`${path}.tmp`, path);
      chmodSync(path, 0o600);
      loadedMtime = null;
    },
  };
}
