// src/main.ts — Composition root: wires all hexagonal layers together
import { homedir } from "node:os";
import { join } from "node:path";
import { createDb } from "./storage/sqlite/db";
import { runMigrations, allMigrations } from "./storage/sqlite/migrations";
import { createSqliteRepos } from "./storage/sqlite";
import { SqliteNotificationQueryRepo } from "./storage/sqlite/notification-query-repo";
import { createNotificationPoller } from "./notifications/poller/poller";
import { MessagingService } from "./core/messaging/service";
import { startMcpStdio } from "./transports/mcp-stdio/adapter";
import { createNotificationDispatcher } from "./notifications/dispatch/dispatcher";
import { YamlProfileStore } from "./storage/yaml-profiles/store";
import { log } from "./log";

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

async function main() {
  // 1. Database
  const dbPath = expandHome(
    process.env.OCTO_SANTA_DB ?? join(homedir(), ".octo-santa", "messages.db")
  );
  const db = createDb(dbPath);
  runMigrations(db, allMigrations);

  // 2. Repositories
  const repos = createSqliteRepos(db);
  const notificationQueries = new SqliteNotificationQueryRepo(db);

  // 3. Notification dispatcher
  const dispatcher = createNotificationDispatcher();

  // 3b. Profile store
  const profilesDir = expandHome(
    process.env.OCTO_SANTA_PROFILES_DIR ?? "~/.octo-santa/profiles"
  );
  const profiles = new YamlProfileStore(profilesDir);

  // 4. Services
  const messaging = new MessagingService(
    repos.agents,
    repos.channels,
    repos.messages,
    repos.cursors,
    process.pid,
    dispatcher,
    profiles
  );

  // 5. Start MCP stdio transport
  const heartbeatIntervalMs = Number(process.env.OCTO_SANTA_HEARTBEAT_INTERVAL_MS) || 10_000;

  await startMcpStdio({
    messaging,
    registerNotificationHandler: dispatcher.register.bind(dispatcher),
    unregisterNotificationHandler: dispatcher.unregister.bind(dispatcher),
    agents: repos.agents,
    startPoller: (port, agentId, baseName) => {
      const poller = createNotificationPoller({
        getNewMessagesForAgent: notificationQueries.getNewMessagesForAgent.bind(notificationQueries),
        getMaxMessageId: notificationQueries.getMaxMessageId.bind(notificationQueries),
        port,
        agentId,
        baseName,
      });
      poller.start();
      return poller;
    },
    heartbeatIntervalMs,
    onDisconnect: (agentId) => {
      messaging.unregister(agentId);
    },
  });
}

main().catch((error) => {
  log(`Failed to start octo-santa: ${error}`);
  process.exit(1);
});
