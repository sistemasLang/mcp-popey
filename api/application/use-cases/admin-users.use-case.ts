import type { AdminAction, AuditLogger } from '../ports/outbound/audit-log.port.js';
import type { IdentityProviderPort, PasswordLink } from '../ports/outbound/identity-provider.port.js';
import type { InternalErrorLogger } from '../ports/outbound/internal-error-log.port.js';
import type { UserAdminRepository, UserRepository } from '../ports/outbound/user-repository.port.js';
import { AppError, UserConflictError, UserManagementError, UserNotFoundError } from '../../domain/errors.js';
import type { RolePolicy } from '../../domain/role-policy.js';
import {
  assertValidUser,
  normalizeEmail,
  SERVICE_NAME_PATTERN,
  toUserView,
  type User,
  type UserView,
} from '../../domain/user.js';

export interface AdminUsersDependencies {
  users: UserRepository & UserAdminRepository;
  identityProvider: IdentityProviderPort;
  rolePolicy: RolePolicy;
  /** databaseKeys configured on this server. */
  databaseKeys: readonly string[];
  audit: Pick<AuditLogger, 'logAdmin'>;
  logInternalError: InternalErrorLogger;
  newId: () => string;
  now?: () => Date;
}

export interface InviteInput {
  email: string;
  admin?: boolean;
  role?: string;
  databaseKey?: string;
}

/** `null` removes role + databaseKey (no /mcp access). Both must change together. */
export interface UpdateInput {
  admin?: boolean;
  enabled?: boolean;
  role?: string | null;
  databaseKey?: string | null;
}

export interface ServiceAccountInput {
  name: string;
  role: string;
  databaseKey: string;
}

export interface InviteResult {
  user: UserView;
  /** null when the user was created but the link could not be issued: issue a new one. */
  passwordLink: PasswordLink | null;
}

export interface UpdateResult {
  user: UserView;
  /** false when the change is saved here but the identity provider call failed (logged). */
  identityProviderSynced: boolean;
}

export interface ServiceAccountResult {
  user: UserView;
  clientId: string;
  clientSecret: string;
}

interface AuditDraft {
  action: AdminAction;
  targetUserId?: string;
  changedFields: string[];
}

type Access = { role?: string; databaseKey?: string };

/**
 * User administration behind /admin/api. Callers pass the already
 * authenticated admin (`actor`). Rules: role and tenant are validated before
 * any identity provider call; the identity provider is called first and the
 * repository second, undoing the provider side if the save fails; at least
 * one enabled admin always remains. Every write is audited, success or not.
 */
export class AdminUsersUseCase {
  constructor(private readonly deps: AdminUsersDependencies) {}

  catalog(): { roles: string[]; databaseKeys: string[] } {
    return { roles: [...this.deps.rolePolicy.roles.keys()].sort(), databaseKeys: [...this.deps.databaseKeys] };
  }

  async list(): Promise<UserView[]> {
    return (await this.deps.users.list()).map(toUserView);
  }

  invite(actor: User, input: InviteInput): Promise<InviteResult> {
    return this.audited(actor, 'invite_user', async (event) => {
      const email = normalizeEmail(input.email);
      const access = this.checkAccess(input.role, input.databaseKey);
      event.changedFields = ['admin', ...Object.keys(access)];

      const existing = await this.deps.users.findByLabel(email);
      if (existing) {
        event.targetUserId = existing.id;
        throw new UserConflictError('DUPLICATE_USER', 'a user with that email already exists');
      }

      const idp = this.deps.identityProvider;
      // A person may already exist at the provider (left over from an earlier, failed attempt).
      const found = await idp.findHumanByEmail(email);
      if (found && (await this.deps.users.findByIdentity(idp.issuer, found.subject))) {
        throw new UserConflictError('DUPLICATE_IDENTITY', 'that identity is already linked to another user');
      }
      const subject = found?.subject ?? (await idp.createHuman(email)).subject;
      if (found) await idp.setHumanBlocked(subject, false);

      const user: User = {
        id: this.deps.newId(),
        kind: 'human',
        label: email,
        admin: input.admin ?? false,
        enabled: true,
        ...access,
        identities: [{ issuer: idp.issuer, subject }],
        createdAt: this.now().toISOString(),
      };
      assertValidUser(user);
      event.targetUserId = user.id;
      await this.saveOrUndo(user, () => idp.setHumanBlocked(subject, true));

      return { user: toUserView(user), passwordLink: await this.tryIssueLink(subject) };
    });
  }

  issuePasswordLink(actor: User, userId: string): Promise<{ passwordLink: PasswordLink }> {
    return this.audited(actor, 'issue_password_link', async (event) => {
      event.targetUserId = userId;
      const user = await this.require(userId);
      if (user.kind !== 'human') throw new UserManagementError('password links are only for people');
      if (!user.enabled) throw new UserConflictError('USER_DISABLED', 'enable the user before issuing a password link');
      return { passwordLink: await this.deps.identityProvider.issuePasswordLink(this.subjectOf(user)) };
    });
  }

  update(actor: User, userId: string, patch: UpdateInput): Promise<UpdateResult> {
    return this.audited(actor, 'update_user', async (event) => {
      event.targetUserId = userId;
      const current = await this.require(userId);
      const next: User = { ...current };
      if (patch.admin !== undefined) next.admin = patch.admin;
      if (patch.enabled !== undefined) next.enabled = patch.enabled;
      if (patch.role !== undefined || patch.databaseKey !== undefined) {
        if (patch.role === undefined || patch.databaseKey === undefined || (patch.role === null) !== (patch.databaseKey === null)) {
          throw new UserManagementError('role and databaseKey must be changed together');
        }
        delete next.role;
        delete next.databaseKey;
        Object.assign(next, this.checkAccess(patch.role ?? undefined, patch.databaseKey ?? undefined));
      }
      assertValidUser(next);

      event.changedFields = (['admin', 'enabled', 'role', 'databaseKey'] as const).filter((field) => current[field] !== next[field]);
      if (current.enabled !== next.enabled) event.action = next.enabled ? 'enable_user' : 'disable_user';
      if (event.changedFields.length === 0) return { user: toUserView(current), identityProviderSynced: true };

      const wasActiveAdmin = current.admin && current.enabled;
      const isActiveAdmin = next.admin && next.enabled;
      if (wasActiveAdmin && !isActiveAdmin && (await this.deps.users.countEnabledAdmins()) <= 1) {
        throw new UserConflictError('LAST_ADMIN', 'at least one enabled admin must remain');
      }

      if (current.enabled && !next.enabled) {
        // Cut access here first: it must hold even if the provider is down.
        await this.deps.users.save(next);
        const synced = await this.tryProviderCall(() => this.setProviderAccess(next, false));
        return { user: toUserView(next), identityProviderSynced: synced };
      }
      // Re-enabling: provider first, so a saved "enabled" user can really log in.
      if (!current.enabled && next.enabled) await this.setProviderAccess(next, true);
      await this.deps.users.save(next);
      return { user: toUserView(next), identityProviderSynced: true };
    });
  }

  createServiceAccount(actor: User, input: ServiceAccountInput): Promise<ServiceAccountResult> {
    return this.audited(actor, 'create_service_account', async (event) => {
      const name = input.name.trim().toLowerCase();
      if (!SERVICE_NAME_PATTERN.test(name)) {
        throw new UserManagementError('name must be 2-64 chars [a-z0-9._-]');
      }
      const access = this.checkAccess(input.role, input.databaseKey);
      event.changedFields = ['role', 'databaseKey'];
      const existing = await this.deps.users.findByLabel(name);
      if (existing) {
        event.targetUserId = existing.id;
        throw new UserConflictError('DUPLICATE_USER', 'a user with that name already exists');
      }

      const idp = this.deps.identityProvider;
      const created = await idp.createServiceClient(name);
      const user: User = {
        id: this.deps.newId(),
        kind: 'service',
        label: name,
        admin: false,
        enabled: true,
        ...access,
        identities: [{ issuer: idp.issuer, subject: created.subject }],
        createdAt: this.now().toISOString(),
      };
      assertValidUser(user);
      event.targetUserId = user.id;
      await this.saveOrUndo(user, () => idp.revokeServiceClient(created.subject));
      return { user: toUserView(user), clientId: created.clientId, clientSecret: created.clientSecret };
    });
  }

  rotateServiceSecret(actor: User, userId: string): Promise<{ clientId: string; clientSecret: string }> {
    return this.audited(actor, 'rotate_service_secret', async (event) => {
      event.targetUserId = userId;
      event.changedFields = ['clientSecret'];
      const user = await this.require(userId);
      if (user.kind !== 'service') throw new UserManagementError('only service accounts have a secret');
      return this.deps.identityProvider.rotateServiceSecret(this.subjectOf(user));
    });
  }

  /** Audits a write the HTTP adapter rejected before reaching a use case (e.g. invalid body). */
  auditRejected(actor: User, action: AdminAction, errorCode: string, targetUserId?: string): void {
    this.log(actor.id, { action, targetUserId, changedFields: [] }, false, errorCode);
  }

  private async audited<T>(actor: User, action: AdminAction, run: (event: AuditDraft) => Promise<T>): Promise<T> {
    const event: AuditDraft = { action, changedFields: [] };
    try {
      const result = await run(event);
      this.log(actor.id, event, true);
      return result;
    } catch (error) {
      this.log(actor.id, event, false, error instanceof AppError ? error.code : 'INTERNAL_ERROR');
      throw error;
    }
  }

  private log(actorUserId: string, event: AuditDraft, success: boolean, errorCode?: string): void {
    this.deps.audit.logAdmin({
      timestamp: this.now().toISOString(),
      actorUserId,
      action: event.action,
      ...(event.targetUserId ? { targetUserId: event.targetUserId } : {}),
      changedFields: event.changedFields,
      success,
      ...(errorCode ? { errorCode } : {}),
    });
  }

  /** role + databaseKey: both or neither, both known. Runs before any provider call. */
  private checkAccess(role: string | undefined, databaseKey: string | undefined): Access {
    if (role === undefined && databaseKey === undefined) return {};
    if (role === undefined || databaseKey === undefined) {
      throw new UserManagementError('role and databaseKey must be set together or not at all');
    }
    const roles = this.deps.rolePolicy.roles;
    if (!roles.has(role)) {
      const known = [...roles.keys()].join(', ') || 'none defined';
      throw new UserManagementError(`role "${role}" is not defined in circuit-access.yaml (known: ${known})`);
    }
    if (!this.deps.databaseKeys.includes(databaseKey)) {
      const known = this.deps.databaseKeys.join(', ') || 'none configured';
      throw new UserManagementError(`database key "${databaseKey}" is not configured in DATABASE_KEYS (known: ${known})`);
    }
    return { role, databaseKey };
  }

  private async require(userId: string): Promise<User> {
    const user = await this.deps.users.findById(userId);
    if (!user) throw new UserNotFoundError('user not found');
    return user;
  }

  private subjectOf(user: User): string {
    const identity = user.identities.find((candidate) => candidate.issuer === this.deps.identityProvider.issuer);
    if (!identity) throw new UserManagementError('user has no identity at the configured identity provider');
    return identity.subject;
  }

  private setProviderAccess(user: User, allowed: boolean): Promise<void> {
    const idp = this.deps.identityProvider;
    const subject = this.subjectOf(user);
    if (user.kind === 'human') return idp.setHumanBlocked(subject, !allowed);
    return allowed ? idp.restoreServiceClient(subject) : idp.revokeServiceClient(subject);
  }

  /** Saves; if that fails, undoes the provider side (best effort) so the orphan cannot log in. */
  private async saveOrUndo(user: User, undo: () => Promise<void>): Promise<void> {
    try {
      await this.deps.users.save(user);
    } catch (error) {
      if (!(error instanceof UserConflictError)) await this.tryProviderCall(undo);
      if (!(error instanceof AppError)) this.deps.logInternalError(error);
      throw error;
    }
  }

  private async tryIssueLink(subject: string): Promise<PasswordLink | null> {
    try {
      return await this.deps.identityProvider.issuePasswordLink(subject);
    } catch (error) {
      this.deps.logInternalError(error);
      return null;
    }
  }

  private async tryProviderCall(call: () => Promise<void>): Promise<boolean> {
    try {
      await call();
      return true;
    } catch (error) {
      this.deps.logInternalError(error);
      return false;
    }
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }
}
