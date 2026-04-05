// src/main.ts — Composition root: wires all hexagonal layers together
import { homedir } from "node:os";
import { join } from "node:path";
import { createDb } from "./storage/sqlite/db";
import { runMigrations, allMigrations } from "./storage/sqlite/migrations";
import { createSqliteRepos } from "./storage/sqlite";
import { createFsBrainStore, readConfig } from "./storage/fs-brain-store/store";
import { MessagingService } from "./core/messaging/service";
import { BrainService } from "./core/brain/service";
import { startMcpStdio } from "./transports/mcp-stdio/adapter";
import { createClaudeNotifier } from "./notifications/claude-notifier/notifier";
import { log } from "./log";

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

async function main() {
  const cwd = process.cwd();

  // 1. Database
  const dbPath = expandHome(
    process.env.OCTO_SANTA_DB ?? join(homedir(), ".octo-santa", "messages.db")
  );
  const db = createDb(dbPath);
  runMigrations(db, allMigrations);

  // 2. Repositories
  const repos = createSqliteRepos(db);

  // 3. Config + brain store
  const config = readConfig(cwd);
  const brainStore = createFsBrainStore(cwd, config?.brain);

  // 4. Services
  const messaging = new MessagingService(
    repos.agents,
    repos.channels,
    repos.messages,
    repos.cursors,
    process.pid
  );

  const brain = new BrainService(
    brainStore,
    repos.domains,
    repos.agents,
    config,
    process.pid
  );

  // 5. Domain registration at startup
  brain.registerDomain(cwd);

  // 6. Compute brain index for bootstrap message
  const hasBrain = !!(config?.brain?.dirs || config?.brain?.files);
  const brainIndex = hasBrain ? brainStore.scanDocs() : undefined;

  // 7. Start MCP stdio transport
  const intervalMs = Number(process.env.OCTO_SANTA_POLL_INTERVAL_MS) || 3000;

  await startMcpStdio({
    messaging,
    brain,
    config,
    brainIndex,
    startNotifier: (agentId, port) =>
      createClaudeNotifier(messaging, repos.agents, port, agentId, intervalMs),
    onDisconnect: (agentId, pid) => {
      messaging.unregister(agentId);
      brain.onDisconnect(agentId, pid);
    },
  });
}

main().catch((error) => {
  log(`Failed to start octo-santa: ${error}`);
  process.exit(1);
});
