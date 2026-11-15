import type { UserRepository } from '../ports/outbound/user-repository.port.js';
import { hashToken, TOKEN_PATTERN } from '../../domain/auth-token.js';
import { AuthenticationError } from '../../domain/errors.js';
import { createUserContext, type UserContext } from '../../domain/user-context.js';

/**
 * Bearer token → UserContext: shape check → token hash lookup → user exists
 * and is enabled. Every failure is the same AuthenticationError, so a caller
 * cannot tell an unknown token from a disabled user.
 */
export class AuthenticateUserUseCase {
  constructor(private readonly users: UserRepository) {}

  async execute(token: string): Promise<UserContext> {
    if (!TOKEN_PATTERN.test(token)) throw new AuthenticationError('Invalid bearer token');

    const userId = await this.users.findIdByTokenHash(hashToken(token));
    if (!userId) throw new AuthenticationError('Invalid bearer token');

    const user = await this.users.findById(userId);
    if (!user || !user.enabled) throw new AuthenticationError('Invalid bearer token');

    return createUserContext(user);
  }
}
