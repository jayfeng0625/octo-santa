import { describe, it, expect, afterEach } from "bun:test";
import { allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { MessagingService } from "../../src/core/messaging/service";
import { startupRepl } from "../../src/transports/repl/startup";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";

const TEST_DB = testDbPath("startup");

function setup() {
  const db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid);
  return { db, svc };
}

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("startupRepl", () => {
  it("creates a PID-bound registered agent row", () => {
    const { db, svc } = setup();
    startupRepl(svc, "jay", "general");

    const agent = db.query("SELECT * FROM agents WHERE id = ?").get("jay") as {
      id: string;
      pid: number | null;
      registered_at: number | null;
    } | null;

    expect(agent).not.toBeNull();
    expect(agent!.pid).toBe(process.pid);
    expect(agent!.registered_at).not.toBeNull();
  });

  it("creates or finds the named channel", () => {
    const { db, svc } = setup();
    startupRepl(svc, "jay", "general");

    const channel = db.query("SELECT * FROM channels WHERE name = ?").get("general") as {
      id: number;
      name: string;
    } | null;

    expect(channel).not.toBeNull();
    expect(channel!.name).toBe("general");
  });

  it("creates a cursor at 0 so new subscriber sees full history", () => {
    const { db, svc } = setup();

    // Pre-seed the channel with some messages from another agent
    svc.register("seeder");
    svc.createChannel("seeder", "general");
    const ch = db.query("SELECT id FROM channels WHERE name = ?").get("general") as { id: number };
    for (let i = 0; i < 3; i++) {
      db.run(
        "INSERT INTO messages (channel_id, agent_id, content, created_at, mentions) VALUES (?, 'seeder', ?, ?, '[]')",
        [ch.id, `msg-${i}`, Date.now()]
      );
    }

    // Now startup jay — cursor should be at 0 (bug #7 fix)
    startupRepl(svc, "jay", "general");

    const cursor = db.query(
      `SELECT last_read_message_id FROM cursors
       WHERE agent_id = ? AND channel_id = (SELECT id FROM channels WHERE name = ?)`
    ).get("jay", "general") as { last_read_message_id: number } | null;

    expect(cursor).not.toBeNull();
    expect(cursor!.last_read_message_id).toBe(0);
  });

  it("idempotency: reconnect does NOT overwrite existing cursor (ON CONFLICT DO NOTHING)", () => {
    const { db, svc } = setup();
    startupRepl(svc, "jay", "general");

    // Manually advance the cursor (simulate reading messages)
    const ch = db.query("SELECT id FROM channels WHERE name = ?").get("general") as { id: number };
    db.run(
      "UPDATE cursors SET last_read_message_id = 42 WHERE agent_id = ? AND channel_id = ?",
      ["jay", ch.id]
    );

    // Add more messages so the naive re-subscribe would advance cursor
    db.run(
      "INSERT INTO messages (channel_id, agent_id, content, created_at, mentions) VALUES (?, 'jay', 'extra', ?, '[]')",
      [ch.id, Date.now()]
    );

    // Simulate reconnect — call startupRepl again
    startupRepl(svc, "jay", "general");

    const cursor = db.query(
      "SELECT last_read_message_id FROM cursors WHERE agent_id = ? AND channel_id = ?",
    ).get("jay", ch.id) as { last_read_message_id: number } | null;

    // Cursor must remain at 42 — ON CONFLICT DO NOTHING preserved it
    expect(cursor!.last_read_message_id).toBe(42);
  });

  it("startup on fresh channel (no messages) sets cursor to 0", () => {
    const { db, svc } = setup();
    startupRepl(svc, "jay", "empty-channel");

    const ch = db.query("SELECT id FROM channels WHERE name = ?").get("empty-channel") as { id: number };
    const cursor = db.query(
      "SELECT last_read_message_id FROM cursors WHERE agent_id = ? AND channel_id = ?",
    ).get("jay", ch.id) as { last_read_message_id: number } | null;

    expect(cursor).not.toBeNull();
    expect(cursor!.last_read_message_id).toBe(0);
  });
});
