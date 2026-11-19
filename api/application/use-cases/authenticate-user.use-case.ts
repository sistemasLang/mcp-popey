import type { UserRepository } from '../ports/outbound/user-repository.port.js';
import { ForbiddenError } from '../../domain/errors.js';
import { createUserContext, type Principal } from '../../domain/user-context.js';
import { hasMcpAccess, type ExternalIdentity, type User } from '../../domain/user.js';

/**
 * Verified `(issuer, subject)` → internal user. The token already proved who
 * the caller is; this decides whether that identity may use each surface.
 * Every refusal is the same ForbiddenError("Forbidden"), so a caller cannot
 * tell an unknown identity from a disabled user or one without a role.
 * Checked on every request: disabling a user cuts live tokens at once.
 */
export class AuthenticateUserUseCase {
  constructor(private readonly users: UserRepository) {}

  /** /mcp: enabled user with role + databaseKey. Admin flag is irrelevant here. */
  async execute(identity: ExternalIdentity): Promise<Principal> {
    const user = await this.users.findByIdentity(identity.issuer, identity.subject);
    if (!user || !user.enabled || !hasMcpAccess(user)) throw new ForbiddenError('Forbidden');
    return Object.freeze({ context: createUserContext(user), kind: user.kind });
  }

  /** /admin/api: enabled human with admin: true. Role is irrelevant here. */
  async authenticateAdmin(identity: ExternalIdentity): Promise<User> {
    const user = await this.users.findByIdentity(identity.issuer, identity.subject);
    if (!user || !user.enabled || user.kind !== 'human' || !user.admin) throw new ForbiddenError('Forbidden');
    return user;
  }
}
