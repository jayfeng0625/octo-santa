// Composition root for the ADMIN MCP connection — a separate entrypoint from
// src/main.ts, so approved external apps connect to an entirely different MCP
// server than the agent-facing messaging tools. Same database, elevated access.
import { createDb, resolveDbPath } from "./storage/sqlite/db";
import { runMigrations, allMigrations } from "./storage/sqlite/migrations";
import { SqliteAdminModule } from "./storage/sqlite/admin-module";
import { AdminService } from "./core/admin/service";
import { TypeScriptRunner } from "./runtime/typescript/runner";
import { startAdminMcpStdio } from "./transports/mcp-admin-stdio/adapter";
import { log } from "./log";

async function main() {
  const db = createDb(resolveDbPath());
  runMigrations(db, allMigrations);

  const timeoutMs = Number(process.env.OCTO_SANTA_ADMIN_TIMEOUT_MS) || undefined;
  const runner = new TypeScriptRunner(timeoutMs);
  const admin = new AdminService(runner, [new SqliteAdminModule(db)]);

  startAdminMcpStdio({ admin });
}

main().catch((error) => {
  log(`Failed to start octo-santa admin: ${error}`);
  process.exit(1);
});
