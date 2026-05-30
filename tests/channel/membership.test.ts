import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { MessagingService } from "../../src/core/messaging/service";
import { createNotificationDispatcher } from "../../src/notifications/dispatch/dispatcher";
import type { NotificationPort, NotificationMeta } from "../../src/core/ports";
import type { Database } from "bun:sqlite";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";

const TEST_DB = testDbPath("membership");

let db: Database;
let svc: MessagingService;

beforeEach(() => {
  db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  const dispatcher = createNotificationDispatcher();
  svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid, dispatcher);
});

afterEach(() => {
  db.close();
  cleanupDb(TEST_DB);
});

describe("DM notification mode", () => {
  it("DM channel push-all works for named agents without mentions", () => {
    const notifications: { content: string; meta: NotificationMeta }[] = [];
    const port: NotificationPort = {
      notify: async (content, meta) => {
        notifications.push({ content, meta });
      },
    };

    svc.register("agent-a");
    svc.register("agent-b");

    // Register agent-a's port with the dispatcher via the svc's dispatcher
    // We need to get the dispatcher — create a fresh one for this test
    const dispatcher = createNotificationDispatcher();
    const repos = createSqliteRepos(db);
    const svcWithDispatcher = new MessagingService(
      repos.agents, repos.channels, repos.messages, repos.cursors, process.pid, dispatcher
    );
    svcWithDispatcher.register("agent-a");
    svcWithDispatcher.register("agent-b");
    dispatcher.register("agent-a", port);

    svcWithDispatcher.directMessage("agent-a", "agent-b", "setup");
    svcWithDispatcher.read("agent-a", "agent-a,agent-b");

    // agent-b sends an unmentioned message — DM mode pushes to agent-a anyway
    svcWithDispatcher.send("agent-b", "agent-a,agent-b", "status update — no mentions");

    expect(notifications.length).toBeGreaterThan(0);
    expect(
      notifications.some((n) => n.content.includes("status update"))
    ).toBe(true);
  });

  it("3rd party cannot send on DM channel", () => {
    svc.register("agent-a");
    svc.register("agent-b");
    svc.register("jay");
    svc.directMessage("agent-a", "agent-b", "private");

    expect(() => svc.send("jay", "agent-a,agent-b", "intruding")).toThrow(
      'DM channel "agent-a,agent-b" is private to agent-a and agent-b'
    );
  });
});
