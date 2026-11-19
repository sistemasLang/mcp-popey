import type { AuditLogger } from '../ports/outbound/audit-log.port.js';
import type { IdentityProviderPort } from '../ports/outbound/identity-provider.port.js';
import type { UserAdminRepository, UserRepository } from '../ports/outbound/user-repository.port.js';
import { ConfigurationError } from '../../domain/errors.js';
import { normalizeEmail, type User } from '../../domain/user.js';

export interface BootstrapAdminsDependencies {
  users: UserRepository & UserAdminRepository;
  identityProvider: IdentityProviderPort;
  audit: Pick<AuditLogger, 'logAdmin'>;
  newId: () => string;
  now?: () => Date;
}

/**
 * First admins on a fresh install. Runs only while no enabled admin exists,
 * so an old BOOTSTRAP_ADMIN_EMAILS can never re-create an admin after a
 * removal. It only LINKS people that already exist at the identity provider
 * (created by hand, with their own password): it never creates users there
 * nor issues password links, because at startup there is no panel to show a
 * link and logs are no place for one. Any problem aborts startup before
 * anything is written.
 */
export class BootstrapAdminsUseCase {
  constructor(private readonly deps: BootstrapAdminsDependencies) {}

  /** Returns how many admins were linked. */
  async execute(emails: readonly string[]): Promise<number> {
    if (emails.length === 0) return 0;
    if ((await this.deps.users.countEnabledAdmins()) > 0) return 0;

    const idp = this.deps.identityProvider;
    const now = (this.deps.now ?? (() => new Date()))().toISOString();
    const pending: User[] = [];
    for (const email of new Set(emails.map(normalizeEmail))) {
      if (await this.deps.users.findByLabel(email)) {
        throw new ConfigurationError(
          `BOOTSTRAP_ADMIN_EMAILS: ${email} already exists in the users file but no admin is enabled; fix the file by hand`,
        );
      }
      const found = await idp.findHumanByEmail(email);
      if (!found) {
        throw new ConfigurationError(
          `BOOTSTRAP_ADMIN_EMAILS: ${email} has no user at the identity provider; create it there first, with its own password (see docs/INSTALACION-VPS.txt)`,
        );
      }
      if (await this.deps.users.findByIdentity(idp.issuer, found.subject)) {
        throw new ConfigurationError(`BOOTSTRAP_ADMIN_EMAILS: the identity of ${email} is already linked to another user`);
      }
      pending.push({
        id: this.deps.newId(),
        kind: 'human',
        label: email,
        admin: true,
        enabled: true,
        identities: [{ issuer: idp.issuer, subject: found.subject }],
        createdAt: now,
      });
    }

    for (const user of pending) {
      await this.deps.users.save(user);
      this.deps.audit.logAdmin({
        timestamp: now,
        actorUserId: 'bootstrap',
        action: 'bootstrap_admin',
        targetUserId: user.id,
        changedFields: ['admin'],
        success: true,
      });
    }
    return pending.length;
  }
}
