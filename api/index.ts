/**
 * Server entrypoint (dist/index.js, the script pm2 runs). Wiring lives in
 * composition/; this file only handles process lifecycle.
 */
import { buildServer, loadRuntimeConfig } from './composition/bootstrap.js';

/** Upper bound for a graceful stop; open SSE streams must not block a pm2 restart. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const { app, summary } = await buildServer(config);

  app.httpServer.on('error', (error: NodeJS.ErrnoException) => {
    const reason =
      error.code === 'EADDRINUSE'
        ? `port ${config.port} on ${config.host} is already in use (check MCP_PORT and \`ss -ltnp | grep -w ${config.port}\`)`
        : error.message;
    console.error(`mcp-popey cannot listen: ${reason}`);
    process.exit(1);
  });

  app.httpServer.listen(config.port, config.host, () => {
    console.error(`mcp-popey listening on http://${config.host}:${config.port}/mcp (${summary})`);
  });

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    console.error(`mcp-popey received ${signal}, shutting down`);
    setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS).unref();
    app.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
