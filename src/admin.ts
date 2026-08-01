// Composition root for the ADMIN MCP connection — a separate entrypoint from
// src/main.ts, so approved external apps connect to an entirely different MCP
// server than the agent-facing messaging plane. Same database, elevated tools.
import { homedir } from "node:os";
import { join } from "node:path";
import { createDb } from "./storage/sqlite/db";
import { runMigrations, allMigrations } from "./storage/sqlite/migrations";
import { SqliteAdminGateway } from "./storage/sqlite/admin-gateway";
import { AdminService } from "./core/admin/service";
import { startAdminMcpStdio } from "./transports/mcp-admin-stdio/adapter";
import { log } from "./log";

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

async function main() {
  const dbPath = expandHome(
    process.env.OCTO_SANTA_DB ?? join(homedir(), ".octo-santa", "messages.db")
  );
  const db = createDb(dbPath);
  runMigrations(db, allMigrations);

  const gateway = new SqliteAdminGateway(db);
  const maxRows = Number(process.env.OCTO_SANTA_ADMIN_MAX_ROWS) || undefined;
  const admin = new AdminService(gateway, maxRows);

  startAdminMcpStdio({ admin });
}

main().catch((error) => {
  log(`Failed to start octo-santa admin: ${error}`);
  process.exit(1);
});
