// End-to-end proof of the admin plane's reason to exist: an approved external
// app (e.g. a Linear/Jira webhook bridge) submits TypeScript to
// admin_search/admin_execute — never raw SQL — and the ordinary messaging
// plane (service reads and the notification watcher's queries) picks up its
// writes exactly as if an agent had sent them. Cross-process by construction:
// the only thing the two planes share is the SQLite file.

import { describe, it, expect, afterEach } from "bun:test";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";
import { allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { SqliteNotificationQueryRepo } from "../../src/storage/sqlite/notification-query-repo";
import { SqliteAdminModule } from "../../src/storage/sqlite/admin-module";
import { MessagingService } from "../../src/core/messaging/service";
import { AdminService } from "../../src/core/admin/service";
import { TypeScriptRunner } from "../../src/runtime/typescript/runner";

const TEST_DB = testDbPath("admin-external-integration");

afterEach(() => {
  cleanupDb(TEST_DB);
});

function setup() {
  const db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  const messaging = new MessagingService(
    repos.agents,
    repos.channels,
    repos.messages,
    process.pid
  );
  const admin = new AdminService(new TypeScriptRunner(), [new SqliteAdminModule(db)]);
  const notificationQueries = new SqliteNotificationQueryRepo(db);
  return { db, messaging, admin, notificationQueries };
}

describe("external app integration via the admin plane", () => {
  it("an issue-tracker bridge delivers a message agents actually receive", async () => {
    const { db, messaging, admin, notificationQueries } = setup();

    // An agent sets up a triage channel through the normal messaging plane.
    messaging.register("triage-bot");
    messaging.createChannel("triage-bot", "eng-triage");

    // The webhook bridge submits one TypeScript program that decides where to
    // push and delivers — the code-mode plan: look up state, act, return only
    // what the caller needs.
    const outcome = await admin.execute(`
      const event = { issue: "LIN-142", status: "In Review" };
      storage.ensureAgent("linear-hook");
      const channel = storage.getChannel("eng-triage");
      if (!channel) throw new Error("triage channel missing");
      const message = storage.postMessage({
        channel: channel.name,
        sender: "linear-hook",
        content: \`\${event.issue} moved to \${event.status}\`,
        mentions: ["*"],
      });
      return { delivered: message.id };
    `);
    expect(outcome.result).toEqual({ delivered: 1 });

    // The messaging plane sees it as a normal unread message...
    const unread = messaging.read("triage-bot", "eng-triage", {});
    expect(unread).toHaveLength(1);
    expect(unread[0]!.agent_id).toBe("linear-hook");
    expect(unread[0]!.content).toBe("LIN-142 moved to In Review");

    // ...and the notification watcher's query surfaces it for push delivery
    // with the mention metadata intact.
    const pending = notificationQueries.getNewMessagesForAgent("triage-bot", 0, 100);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.mentions).toBe('["*"]');
    expect(pending[0]!.channel_name).toBe("eng-triage");

    db.close();
  });

  it("write methods are absent from admin_search runs", async () => {
    const { db, admin } = setup();
    const surface = await admin.search(
      `return { post: typeof (storage as any).postMessage, list: typeof storage.listChannels };`
    );
    expect(surface.result).toEqual({ post: "undefined", list: "function" });
    // Attempting the write anyway fails inside the code run.
    expect(
      admin.search(`(storage as any).postMessage({}); return 1;`)
    ).rejects.toThrow();
    db.close();
  });

  it("supports OLAP analytics in code without touching cursors", async () => {
    const { db, messaging, admin } = setup();

    messaging.register("alice");
    messaging.register("bob");
    messaging.createChannel("alice", "metrics");
    messaging.subscribe("bob", "metrics");
    messaging.send("alice", "metrics", "one");
    messaging.send("alice", "metrics", "two");
    messaging.send("bob", "metrics", "three");

    // Aggregation + reshaping happens inside the run; only the digest returns.
    const outcome = await admin.search(`
      const perSender = storage.countMessages({ channel: "metrics", groupBy: "sender" });
      const total = storage.countMessages({ channel: "metrics" })[0].count;
      console.log("rows scanned:", total);
      return Object.fromEntries(perSender.map((r) => [r.group, r.count]));
    `);
    expect(outcome.result).toEqual({ alice: 2, bob: 1 });
    expect(outcome.logs).toEqual(["[log] rows scanned: 3"]);

    // Analytics reads are pure: bob's unread cursor is untouched.
    const unread = messaging.read("bob", "metrics", {});
    expect(unread.map((m) => m.content)).toEqual(["one", "two"]);

    db.close();
  });

  it("supports incremental pull loops via getMaxMessageId and afterId", async () => {
    const { db, messaging, admin } = setup();
    messaging.register("worker");
    messaging.createChannel("worker", "feed");

    const hwm = await admin.search(`return storage.getMaxMessageId();`);
    messaging.send("worker", "feed", "new event");

    const delta = await admin.search(`
      const rows = storage.getMessages({ afterId: ${JSON.stringify(hwm.result)} });
      return rows.map((m) => ({ channel: m.channel, content: m.content }));
    `);
    expect(delta.result).toEqual([{ channel: "feed", content: "new event" }]);
    db.close();
  });
});
