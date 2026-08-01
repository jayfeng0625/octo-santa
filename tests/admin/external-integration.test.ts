// End-to-end proof of the admin plane's reason to exist: an approved external
// app (e.g. a Linear/Jira webhook bridge) uses only admin_search/admin_execute
// to push a message directly into the database, and the ordinary messaging
// plane — service reads and the notification watcher's queries — picks it up
// exactly as if an agent had sent it. Cross-process by construction: the only
// thing the two planes share is the SQLite file.

import { describe, it, expect, afterEach } from "bun:test";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";
import { allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { SqliteNotificationQueryRepo } from "../../src/storage/sqlite/notification-query-repo";
import { SqliteAdminGateway } from "../../src/storage/sqlite/admin-gateway";
import { MessagingService } from "../../src/core/messaging/service";
import { AdminService } from "../../src/core/admin/service";

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
  const admin = new AdminService(new SqliteAdminGateway(db));
  const notificationQueries = new SqliteNotificationQueryRepo(db);
  return { db, messaging, admin, notificationQueries };
}

describe("external app integration via the admin plane", () => {
  it("an issue-tracker bridge can deliver a message agents actually receive", () => {
    const { db, messaging, admin, notificationQueries } = setup();

    // An agent sets up a triage channel through the normal messaging plane.
    messaging.register("triage-bot");
    const channel = messaging.createChannel("triage-bot", "eng-triage");

    // The external bridge, on a webhook, uses only search + execute:
    // register itself as a sender...
    admin.execute(
      "INSERT OR IGNORE INTO agents (id, created_at, last_seen_at) VALUES (?, ?, ?)",
      ["linear-hook", 1, 1]
    );
    // ...resolve the channel...
    const found = admin.search("SELECT id FROM channels WHERE name = ?", [
      "eng-triage",
    ]);
    expect(found.rows).toEqual([{ id: channel.id }]);
    // ...and insert-to-deliver, mentioning @all so live members get pushed.
    admin.execute(
      "INSERT INTO messages (channel_id, agent_id, content, created_at, mentions) VALUES (?, ?, ?, ?, ?)",
      [channel.id, "linear-hook", "LIN-142 moved to In Review", Date.now(), '["*"]']
    );

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

  it("supports OLAP analytics over message history without touching cursors", () => {
    const { db, messaging, admin } = setup();

    messaging.register("alice");
    messaging.register("bob");
    messaging.createChannel("alice", "metrics");
    messaging.subscribe("bob", "metrics");
    messaging.send("alice", "metrics", "one");
    messaging.send("alice", "metrics", "two");
    messaging.send("bob", "metrics", "three");

    const stats = admin.search(
      `SELECT m.agent_id, COUNT(*) AS sent
       FROM messages m JOIN channels c ON c.id = m.channel_id
       WHERE c.name = ?
       GROUP BY m.agent_id
       ORDER BY m.agent_id`,
      ["metrics"]
    );
    expect(stats.rows).toEqual([
      { agent_id: "alice", sent: 2 },
      { agent_id: "bob", sent: 1 },
    ]);

    // Analytics reads are pure: bob's unread cursor is untouched.
    const unread = messaging.read("bob", "metrics", {});
    expect(unread.map((m) => m.content)).toEqual(["one", "two"]);

    db.close();
  });
});
