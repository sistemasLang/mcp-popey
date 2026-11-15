import { describe, expect, it } from 'vitest';
import { InMemoryUserRepository } from '../../api/adapters/outbound/memory/in-memory-user.repository.js';
import { SlidingWindowRateLimiter } from '../../api/adapters/outbound/memory/sliding-window.rate-limiter.js';
import { RolePolicyLoader } from '../../api/adapters/outbound/yaml/role-policy.loader.js';
import { AuthorizationService } from '../../api/application/services/authorization.service.js';
import { AuthenticateUserUseCase } from '../../api/application/use-cases/authenticate-user.use-case.js';
import { ManageUsersUseCase } from '../../api/application/use-cases/manage-users.use-case.js';
import { QuerySqlUseCase } from '../../api/application/use-cases/query-sql.use-case.js';
import { AuthenticationError, AuthorizationError, UserManagementError } from '../../api/domain/errors.js';
import { hashToken } from '../../api/domain/auth-token.js';
import { SQL_QUERY_LIMITS } from '../../api/domain/security/query-limits.js';
import { SpyDatabaseAdapter, TEST_ROLE_POLICY } from '../e2e-harness.js';
import { loadRealRegistry } from '../helpers.js';

const registry = loadRealRegistry();
const rolePolicy = RolePolicyLoader.parse(TEST_ROLE_POLICY, registry);

function manageUsers(users = new InMemoryUserRepository()) {
  let next = 0;
  const useCase = new ManageUsersUseCase({
    users,
    rolePolicy: () => rolePolicy,
    databaseKeys: () => ['lang', 'powerbi'],
    newId: () => `id-${++next}`,
    now: () => new Date('2026-01-01T00:00:00Z'),
  });
  return { users, useCase };
}

describe('ManageUsersUseCase', () => {
  it('creates a user whose token authenticates, storing only its hash', async () => {
    const { users, useCase } = manageUsers();
    const issued = useCase.create({ username: 'Juan', role: 'ventas', databaseKey: 'lang' });

    expect(issued.action).toBe('created');
    expect(issued.record).toMatchObject({ id: 'id-1', username: 'juan', enabled: true, tokenSha256: hashToken(issued.token) });
    expect(JSON.stringify(users.findRecordByUsername('juan'))).not.toContain(issued.token);
    await expect(new AuthenticateUserUseCase(users).execute(issued.token)).resolves.toEqual({
      userId: 'id-1',
      role: 'ventas',
      databaseKey: 'lang',
    });
  });

  it.each([
    [{ username: 'x', role: 'ventas', databaseKey: 'lang' }, /username/],
    [{ username: 'juan', role: 'gerente', databaseKey: 'lang' }, /role "gerente" is not defined/],
    [{ username: 'juan', role: 'ventas', databaseKey: 'otra' }, /database key "otra"/],
  ])('rejects invalid input %#', (input, message) => {
    expect(() => manageUsers().useCase.create(input)).toThrow(message);
  });

  it('refuses duplicates; rotate keeps the id and invalidates the old token', async () => {
    const { users, useCase } = manageUsers();
    const first = useCase.create({ username: 'juan', role: 'ventas', databaseKey: 'lang' });
    expect(() => useCase.create({ username: 'juan', role: 'ventas', databaseKey: 'lang' })).toThrow(UserManagementError);

    const rotated = useCase.rotate({ username: 'juan' });
    expect(rotated.record.id).toBe(first.record.id);
    const auth = new AuthenticateUserUseCase(users);
    await expect(auth.execute(first.token)).rejects.toThrow(AuthenticationError);
    await expect(auth.execute(rotated.token)).resolves.toMatchObject({ userId: first.record.id });
  });

  it('disable works without loading the catalog and blocks the token', async () => {
    const users = new InMemoryUserRepository();
    const { useCase: setup } = manageUsers(users);
    const issued = setup.create({ username: 'juan', role: 'ventas', databaseKey: 'lang' });

    const broken = new ManageUsersUseCase({
      users,
      rolePolicy: () => {
        throw new Error('catalog must not be loaded to disable');
      },
      databaseKeys: () => {
        throw new Error('databases must not be loaded to disable');
      },
      newId: () => 'unused',
    });
    expect(broken.disable('juan').enabled).toBe(false);
    await expect(new AuthenticateUserUseCase(users).execute(issued.token)).rejects.toThrow(AuthenticationError);
  });
});

describe('QuerySqlUseCase', () => {
  const authorization = new AuthorizationService(rolePolicy, registry);
  const limiter = () => new SlidingWindowRateLimiter({ maxRequests: 100, windowMs: 60_000 });

  it('rejects roles without sql: true even if called directly, before touching the database', async () => {
    const database = new SpyDatabaseAdapter();
    const useCase = new QuerySqlUseCase(authorization, limiter(), database, SQL_QUERY_LIMITS);
    expect(() => useCase.execute({ userId: 'u', role: 'ventas', databaseKey: 'lang' }, 'SELECT 1')).toThrow(
      AuthorizationError,
    );
    expect(database.calls).toEqual([]);
  });

  it('runs on the UserContext database with the configured limits', async () => {
    const database = new SpyDatabaseAdapter();
    const useCase = new QuerySqlUseCase(authorization, limiter(), database, { maxRows: 7, timeoutMs: 1234 });
    await useCase.execute({ userId: 'u', role: 'analista', databaseKey: 'powerbi' }, 'SELECT 1');
    expect(database.calls).toEqual([{ databaseKey: 'powerbi', sql: 'SELECT 1', params: [] }]);
    expect(database.sqlOptions).toEqual([{ maxRows: 7, timeoutMs: 1234 }]);
  });
});
