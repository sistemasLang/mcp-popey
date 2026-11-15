/**
 * Entrypoint: creates (or rotates / disables) an MCP user and prints its token ONCE.
 * Console-only: there is no HTTP endpoint to manage users. Compiled to
 * dist/cli/create-user.js (path used by the VPS docs; keep it stable).
 */
import { runCreateUserCli } from '../adapters/inbound/cli/create-user.cli.js';
import { buildManageUsers, loadRuntimeConfig } from '../composition/bootstrap.js';

try {
  const config = loadRuntimeConfig();
  runCreateUserCli(process.argv.slice(2), () => buildManageUsers(config), config.usersFile, { out: console.log });
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
