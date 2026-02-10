import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { createDb } from "../../src/db";
import { runMigrations } from "../../src/migrations";
import {
  messagingMigrations,
  registerAgent,
  createChannel,
  sendMessage,
} from "../../src/modules/messaging/tools";

const TEST_DB = "/tmp/octo-santa-test-send.sqlite";

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

describe("sendMessage", () => {
  it("sends a message and returns the message with an ID", () => {
    const db = setupDb();
    const msg = sendMessage(db, "octo-santa", "coordination", "Hello world");

    expect(msg.id).toBeGreaterThan(0);
    expect(msg.agent_id).toBe("octo-santa");
    expect(msg.content).toBe("Hello world");
    expect(msg.created_at).toBeGreaterThan(0);

    db.close();
  });

  it("auto-creates channel and registers agent if needed", () => {
    const db = setupDb();
    const msg = sendMessage(db, "new-agent", "new-channel", "First message");

    expect(msg.agent_id).toBe("new-agent");
    expect(msg.channel_id).toBeGreaterThan(0);

    db.close();
  });

  it("messages get sequential IDs", () => {
    const db = setupDb();
    const msg1 = sendMessage(db, "agent-a", "general", "First");
    const msg2 = sendMessage(db, "agent-b", "general", "Second");

    expect(msg2.id).toBeGreaterThan(msg1.id);

    db.close();
  });

  it("updates agent last_seen_at on send", () => {
    const db = setupDb();
    const before = registerAgent(db, "octo-santa");
    sendMessage(db, "octo-santa", "general", "ping");
    const after = db.query("SELECT * FROM agents WHERE id = ?").get("octo-santa") as { last_seen_at: number };

    expect(after.last_seen_at).toBeGreaterThanOrEqual(before.last_seen_at);

    db.close();
  });
});
