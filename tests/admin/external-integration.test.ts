// End-to-end proof of the admin API's reason to exist: an approved external
// app (e.g. a Linear/Jira webhook bridge) discovers what to call with search,
// then submits TypeScript to execute — never raw SQL — and the ordinary
// messaging plane (service reads and the notification watcher's queries)
// picks up its writes exactly as if an agent had sent them. Cross-process by
// construction: the only thing the two planes share is the SQLite file.

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

describe("external app integration via the admin API", () => {
  it("a bridge discovers how to send with search, then delivers with execute", async () => {
    const { db, messaging, admin, notificationQueries } = setup();

    // An agent sets up a triage channel through the normal messaging plane.
    messaging.register("triage-bot");
    messaging.createChannel("triage-bot", "eng-triage");

    // Step 1 — discovery: the bridge searches the declarations for what it
    // needs instead of loading the whole document into context.
    const found = admin.search("send message to a channel");
    expect(found.matches[0]!.name).toBe("sendMessage");
    const declaration = found.matches[0]!.declaration;
    expect(declaration).toContain("sendMessage(input: SendMessageInput)");

    // Step 2 — execution: one TypeScript program that decides where to push
    // and delivers, returning only what the caller needs.
    const outcome = await admin.execute(`
      const event = { issue: "LIN-142", status: "In Review" };
      storage.createAgentIfMissing("linear-hook");
      const channel = storage.getChannel("eng-triage");
      if (!channel) throw new Error("triage channel missing");
      const message = storage.sendMessage({
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

  it("supports reporting over history in code without touching cursors", async () => {
    const { db, messaging, admin } = setup();

    messaging.register("alice");
    messaging.register("bob");
    messaging.createChannel("alice", "metrics");
    messaging.subscribe("bob", "metrics");
    messaging.send("alice", "metrics", "one");
    messaging.send("alice", "metrics", "two");
    messaging.send("bob", "metrics", "three");

    // Counting + reshaping happens inside the run; only the digest returns.
    const outcome = await admin.execute(`
      const perSender = storage.countMessages({ channel: "metrics", group_by: "sender" });
      const total = storage.countMessages({ channel: "metrics" })[0].count;
      console.log("rows scanned:", total);
      return Object.fromEntries(perSender.map((r) => [r.value, r.count]));
    `);
    expect(outcome.result).toEqual({ alice: 2, bob: 1 });
    expect(outcome.logs).toEqual(["[log] rows scanned: 3"]);

    // Reporting reads are pure: bob's unread cursor is untouched.
    const unread = messaging.read("bob", "metrics", {});
    expect(unread.map((m) => m.content)).toEqual(["one", "two"]);

    db.close();
  });

  it("supports incremental pull loops via getLatestMessageId and after_id", async () => {
    const { db, messaging, admin } = setup();
    messaging.register("worker");
    messaging.createChannel("worker", "feed");

    const hwm = await admin.execute(`return storage.getLatestMessageId();`);
    messaging.send("worker", "feed", "new event");

    const delta = await admin.execute(`
      const rows = storage.getMessages({ after_id: ${JSON.stringify(hwm.result)} });
      return rows.map((m) => ({ channel: m.channel, content: m.content }));
    `);
    expect(delta.result).toEqual([{ channel: "feed", content: "new event" }]);
    db.close();
  });
});
