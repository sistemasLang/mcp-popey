/**
 * Creates (or rotates / disables) an MCP user and prints its token ONCE.
 * Console-only: there is no HTTP endpoint to manage users.
 *
 *   node dist/cli/create-user.js --username juan --role ventas --database-key lang
 *   node dist/cli/create-user.js --username juan --rotate
 *   node dist/cli/create-user.js --username juan --disable
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { generateToken, hashToken } from '../auth/token-verifier.js';
import { CircuitLoader } from '../circuits/circuit.loader.js';
import { CircuitRegistry } from '../circuits/circuit.registry.js';
import { buildConfig } from '../config/config.js';
import { loadDotEnv, readEnv } from '../config/env.js';
import { DatabaseRegistry } from '../database/database.registry.js';
import { RolePolicyLoader } from '../permissions/role-policy.loader.js';
import { YamlUserRepository } from '../users/user.repository.js';

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function main(): void {
  const { values } = parseArgs({
    options: {
      username: { type: 'string' },
      role: { type: 'string' },
      'database-key': { type: 'string' },
      rotate: { type: 'boolean', default: false },
      disable: { type: 'boolean', default: false },
    },
    strict: true,
  });

  loadDotEnv();
  const config = buildConfig(readEnv());
  const users = new YamlUserRepository(config.usersFile);

  const username = values.username?.toLowerCase();
  if (!username || !USERNAME_PATTERN.test(username)) fail('--username is required: 2-64 chars [a-z0-9._-]');
  if (values.rotate && values.disable) fail('--rotate and --disable are mutually exclusive');

  const existing = users.findRecordByUsername(username);

  if (values.disable) {
    if (!existing) fail(`user "${username}" does not exist`);
    users.save({ ...existing, enabled: false });
    console.log(`User "${username}" disabled in ${config.usersFile}`);
    return;
  }

  if (existing && !values.rotate) fail(`user "${username}" already exists (use --rotate for a new token)`);
  if (!existing && values.rotate) fail(`user "${username}" does not exist`);

  const role = values.role ?? existing?.role;
  const databaseKey = values['database-key'] ?? existing?.databaseKey;
  if (!role) fail('--role is required');
  if (!databaseKey) fail('--database-key is required');

  const circuitRegistry = CircuitRegistry.fromDefinitions(CircuitLoader.loadFile(config.circuitsFile));
  const rolePolicy = RolePolicyLoader.loadFile(config.circuitAccessFile, circuitRegistry);
  if (!rolePolicy.roles.has(role)) {
    const known = [...rolePolicy.roles.keys()].join(', ') || 'none defined';
    fail(`role "${role}" is not defined in ${config.circuitAccessFile} (known: ${known})`);
  }

  const databases = DatabaseRegistry.fromEnv();
  if (!databases.has(databaseKey)) {
    const known = databases.keys().join(', ') || 'none configured';
    fail(`database key "${databaseKey}" is not configured in DATABASE_KEYS (known: ${known})`);
  }

  const token = generateToken();
  users.save({
    id: existing?.id ?? randomUUID(),
    username,
    role,
    databaseKey,
    enabled: true,
    tokenSha256: hashToken(token),
    createdAt: new Date().toISOString(),
  });

  console.log(`User "${username}" ${existing ? 'rotated' : 'created'} in ${config.usersFile}`);
  console.log(`  role: ${role}  databaseKey: ${databaseKey}`);
  console.log('Token (shown ONCE, store it now):');
  console.log(token);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
