import type { IncomingMessage } from 'node:http';
import { AuthenticationError } from '../errors/app-errors.js';
import type { UserRepository } from '../users/user.repository.js';
import type { TokenVerifier } from './token-verifier.js';
import { createUserContext, type UserContext } from './user-context.js';

/**
 * HTTP request → UserContext.
 * Bearer token → TokenVerifier → UserRepository → enabled check → UserContext.
 */
export class AuthMiddleware {
  constructor(
    private readonly tokenVerifier: TokenVerifier,
    private readonly users: UserRepository,
  ) {}

  async authenticate(request: Pick<IncomingMessage, 'headers'>): Promise<UserContext> {
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
    if (!match?.[1]) throw new AuthenticationError('Missing bearer token');

    const userId = await this.tokenVerifier.verify(match[1]);
    const user = await this.users.findById(userId);
    if (!user || !user.enabled) throw new AuthenticationError('Invalid bearer token');

    return createUserContext(user);
  }
}
