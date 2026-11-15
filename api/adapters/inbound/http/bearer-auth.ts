import type { IncomingMessage } from 'node:http';
import type { AuthenticateUserUseCase } from '../../../application/use-cases/authenticate-user.use-case.js';
import { AuthenticationError } from '../../../domain/errors.js';
import type { UserContext } from '../../../domain/user-context.js';

/** HTTP request → bearer token → AuthenticateUserUseCase → UserContext. */
export class BearerAuth {
  constructor(private readonly authenticateUser: AuthenticateUserUseCase) {}

  authenticate(request: Pick<IncomingMessage, 'headers'>): Promise<UserContext> {
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
    if (!match?.[1]) return Promise.reject(new AuthenticationError('Missing bearer token'));
    return this.authenticateUser.execute(match[1]);
  }
}
