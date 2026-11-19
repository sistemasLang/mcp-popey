import type { UserAdminRepository, UserRepository } from '../../../application/ports/outbound/user-repository.port.js';
import { assertUniqueIdentities, assertValidUser, type User } from '../../../domain/user.js';

/** In-process repository (tests, tooling). Same rules as the YAML one. */
export class InMemoryUserRepository implements UserRepository, UserAdminRepository {
  private users: User[];
  /** Makes the next save() fail (tests of compensation). */
  failNextSave: Error | null = null;

  constructor(users: User[] = []) {
    this.users = users.map((user) => structuredClone(user));
  }

  async findByIdentity(issuer: string, subject: string): Promise<User | null> {
    return copy(
      this.users.find((user) =>
        user.identities.some((identity) => identity.issuer === issuer && identity.subject === subject),
      ),
    );
  }

  async findById(id: string): Promise<User | null> {
    return copy(this.users.find((user) => user.id === id));
  }

  async findByLabel(label: string): Promise<User | null> {
    return copy(this.users.find((user) => user.label === label));
  }

  async list(): Promise<User[]> {
    return this.users.map((user) => structuredClone(user));
  }

  async countEnabledAdmins(): Promise<number> {
    return this.users.filter((user) => user.admin && user.enabled).length;
  }

  async save(user: User): Promise<void> {
    if (this.failNextSave) {
      const error = this.failNextSave;
      this.failNextSave = null;
      throw error;
    }
    assertValidUser(user);
    const users = [...this.users.filter((existing) => existing.id !== user.id), structuredClone(user)];
    assertUniqueIdentities(users);
    this.users = users;
  }
}

function copy(user: User | undefined): User | null {
  return user ? structuredClone(user) : null;
}
