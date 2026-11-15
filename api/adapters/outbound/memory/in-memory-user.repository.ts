import type { UserAdminRepository, UserRepository } from '../../../application/ports/outbound/user-repository.port.js';
import { tokenHashesMatch } from '../../../domain/auth-token.js';
import { toUser, type User, type UserRecord } from '../../../domain/user.js';

/** In-process repository (tests, tooling). */
export class InMemoryUserRepository implements UserRepository, UserAdminRepository {
  private readonly records: UserRecord[];

  constructor(records: UserRecord[] = []) {
    this.records = [...records];
  }

  async findById(id: string): Promise<User | null> {
    const record = this.records.find((candidate) => candidate.id === id);
    return record ? toUser(record) : null;
  }

  async findIdByTokenHash(tokenSha256: string): Promise<string | null> {
    let match: string | null = null;
    for (const record of this.records) {
      if (tokenHashesMatch(record.tokenSha256, tokenSha256)) match = record.id;
    }
    return match;
  }

  findRecordByUsername(username: string): UserRecord | undefined {
    return this.records.find((record) => record.username === username);
  }

  save(record: UserRecord): void {
    const index = this.records.findIndex((existing) => existing.id === record.id);
    if (index >= 0) this.records[index] = record;
    else this.records.push(record);
  }
}
