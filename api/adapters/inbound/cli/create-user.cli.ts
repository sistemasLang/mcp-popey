import { parseArgs } from 'node:util';
import type { ManageUsersUseCase } from '../../../application/use-cases/manage-users.use-case.js';

export const USAGE = [
  'node dist/cli/create-user.js --username juan --role ventas --database-key lang',
  'node dist/cli/create-user.js --username juan --rotate [--role r] [--database-key k]',
  'node dist/cli/create-user.js --username juan --disable',
].join('\n  ');

export interface CliIo {
  out: (line: string) => void;
}

/**
 * argv → ManageUsersUseCase. Prints the token ONCE; it is never stored in plain text.
 * Throws on invalid input; the entrypoint turns that into exit code 1.
 */
export function runCreateUserCli(argv: string[], useCase: () => ManageUsersUseCase, usersFile: string, io: CliIo): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      username: { type: 'string' },
      role: { type: 'string' },
      'database-key': { type: 'string' },
      rotate: { type: 'boolean', default: false },
      disable: { type: 'boolean', default: false },
    },
    strict: true,
  });

  if (!values.username) throw new Error(`--username is required\n  ${USAGE}`);
  if (values.rotate && values.disable) throw new Error('--rotate and --disable are mutually exclusive');

  if (values.disable) {
    const disabled = useCase().disable(values.username);
    io.out(`User "${disabled.username}" disabled in ${usersFile}`);
    return;
  }

  let issued;
  if (values.rotate) {
    issued = useCase().rotate({
      username: values.username,
      role: values.role,
      databaseKey: values['database-key'],
    });
  } else {
    if (!values.role) throw new Error('--role is required');
    if (!values['database-key']) throw new Error('--database-key is required');
    issued = useCase().create({ username: values.username, role: values.role, databaseKey: values['database-key'] });
  }

  io.out(`User "${issued.record.username}" ${issued.action} in ${usersFile}`);
  io.out(`  role: ${issued.record.role}  databaseKey: ${issued.record.databaseKey}`);
  io.out('Token (shown ONCE, store it now):');
  io.out(issued.token);
}
