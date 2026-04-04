import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { createDb } from "../../src/db";
import { runMigrations } from "../../src/migrations";
import { messagingMigrations, registerAgent, createChannel } from "../../src/modules/messaging/tools";
import { startupRepl } from "../../src/repl/startup";

const TEST_DB = "/tmp/octo-santa-test-startup.sqlite";

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = path + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
}

function setupDb() {
  cleanupDb(TEST_DB);
  const db = createDb(TEST_DB);
  runMigrations(db, messagingMigrations);
  return db;
}

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("startupRepl", () => {
  it("creates a PID-bound registered agent row", () => {
    const db = setupDb();
    startupRepl(db, "jay", "general");

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
    const db = setupDb();
    startupRepl(db, "jay", "general");

    const channel = db.query("SELECT * FROM channels WHERE name = ?").get("general") as {
      id: number;
      name: string;
    } | null;

    expect(channel).not.toBeNull();
    expect(channel!.name).toBe("general");
  });

  it("creates a cursor at the current max message ID", () => {
    const db = setupDb();

    // Pre-seed the channel with some messages from another agent
    registerAgent(db, "seeder");
    createChannel(db, "general", "seeder");
    // seeder sends 3 messages — cursor should land at max id
    const ch = db.query("SELECT id FROM channels WHERE name = ?").get("general") as { id: number };
    for (let i = 0; i < 3; i++) {
      db.run(
        "INSERT INTO messages (channel_id, agent_id, content, created_at, mentions) VALUES (?, 'seeder', ?, ?, '[]')",
        [ch.id, `msg-${i}`, Date.now()]
      );
    }
    const maxRow = db.query("SELECT MAX(id) as max_id FROM messages WHERE channel_id = ?").get(ch.id) as { max_id: number };

    // Now startup jay — cursor should be at maxId, not 0
    startupRepl(db, "jay", "general");

    const cursor = db.query(
      `SELECT last_read_message_id FROM cursors
       WHERE agent_id = ? AND channel_id = (SELECT id FROM channels WHERE name = ?)`
    ).get("jay", "general") as { last_read_message_id: number } | null;

    expect(cursor).not.toBeNull();
    expect(cursor!.last_read_message_id).toBe(maxRow.max_id);
  });

  it("idempotency: reconnect does NOT overwrite existing cursor (ON CONFLICT DO NOTHING)", () => {
    const db = setupDb();
    startupRepl(db, "jay", "general");

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
    startupRepl(db, "jay", "general");

    const cursor = db.query(
      "SELECT last_read_message_id FROM cursors WHERE agent_id = ? AND channel_id = ?",
    ).get("jay", ch.id) as { last_read_message_id: number } | null;

    // Cursor must remain at 42 — ON CONFLICT DO NOTHING preserved it
    expect(cursor!.last_read_message_id).toBe(42);
  });

  it("startup on fresh channel (no messages) sets cursor to 0", () => {
    const db = setupDb();
    startupRepl(db, "jay", "empty-channel");

    const ch = db.query("SELECT id FROM channels WHERE name = ?").get("empty-channel") as { id: number };
    const cursor = db.query(
      "SELECT last_read_message_id FROM cursors WHERE agent_id = ? AND channel_id = ?",
    ).get("jay", ch.id) as { last_read_message_id: number } | null;

    expect(cursor).not.toBeNull();
    expect(cursor!.last_read_message_id).toBe(0);
  });
});
