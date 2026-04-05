import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { MessagingService } from "../../src/core/messaging/service";
import { createClaudeNotifier } from "../../src/notifications/claude-notifier/notifier";
import type { NotificationPort } from "../../src/core/ports";
import type { Database } from "bun:sqlite";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";

const TEST_DB = testDbPath("membership");

let db: Database;
let svc: MessagingService;

beforeEach(() => {
  db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid);
});

afterEach(() => {
  db.close();
  cleanupDb(TEST_DB);
});

describe("DM notification mode", () => {
  it("DM channel push-all works for named agents without mentions", async () => {
    svc.register("agent-a");
    svc.register("agent-b");
    svc.directMessage("agent-a", "agent-b", "setup");
    svc.read("agent-a", "agent-a,agent-b");

    // agent-b sends an unmentioned message — DM mode pushes to agent-a anyway
    svc.send("agent-b", "agent-a,agent-b", "status update — no mentions");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const port: NotificationPort = {
      notify: async (content, meta) => {
        notifications.push({ content, meta });
      },
    };

    const repos = createSqliteRepos(db);
    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-a", 50);
    await new Promise((r) => setTimeout(r, 200));
    await stop();

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
