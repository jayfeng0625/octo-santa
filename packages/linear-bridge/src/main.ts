import { AdminClient } from "./admin-client";
import { createBridgeServer } from "./server";

// Composition root: real admin subprocess + HTTP server, both driven by env.
// OCTO_SANTA_DB is passed through explicitly so the spawned admin server and
// this bridge always agree on which shared database is in play.
const client = new AdminClient({
  env: { OCTO_SANTA_DB: process.env.OCTO_SANTA_DB },
});
const server = createBridgeServer({ client });

console.log(
  `[linear-bridge] listening on http://localhost:${server.port} ` +
    "(POST /webhooks/linear, GET /healthz)"
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[linear-bridge] ${signal} received, shutting down`);
  server.stop();
  await client.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
