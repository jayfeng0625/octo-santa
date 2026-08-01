import { homedir } from "node:os";
import { join } from "node:path";
import { createDb } from "./storage/sqlite/db";
import { runMigrations, allMigrations } from "./storage/sqlite/migrations";
import { createSqliteRepos } from "./storage/sqlite";
import { SqliteNotificationQueryRepo } from "./storage/sqlite/notification-query-repo";
import { createNotificationPoller } from "./notifications/poller/poller";
import { MessagingService } from "./core/messaging/service";
import { startMcpStdio } from "./transports/mcp-stdio/adapter";
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

  const repos = createSqliteRepos(db);
  const notificationQueries = new SqliteNotificationQueryRepo(db);

  const messaging = new MessagingService(
    repos.agents,
    repos.channels,
    repos.messages,
    process.pid
  );

  const heartbeatIntervalMs = Number(process.env.OCTO_SANTA_HEARTBEAT_INTERVAL_MS) || 10_000;
  const pollIntervalMs = Number(process.env.OCTO_SANTA_POLL_INTERVAL_MS) || undefined;

  startMcpStdio({
    messaging,
    agents: repos.agents,
    startPoller: (port, agentId) => {
      const poller = createNotificationPoller({
        getNewMessagesForAgent: notificationQueries.getNewMessagesForAgent.bind(notificationQueries),
        getMaxMessageId: notificationQueries.getMaxMessageId.bind(notificationQueries),
        port,
        agentId,
        intervalMs: pollIntervalMs,
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
