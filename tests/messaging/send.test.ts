import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { createDb } from "../../src/db";
import { runMigrations } from "../../src/migrations";
import {
  messagingMigrations,
  registerAgent,
  createChannel,
  sendMessage,
  readMessages,
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

  it("stores parsed mentions in message", () => {
    const db = setupDb();
    registerAgent(db, "reviewer");
    const msg = sendMessage(db, "agent-a", "coordination", "@reviewer check this");

    expect(JSON.parse(msg.mentions)).toEqual(["reviewer"]);
    db.close();
  });

  it("stores empty array when no mentions", () => {
    const db = setupDb();
    const msg = sendMessage(db, "agent-a", "coordination", "just a message");

    expect(JSON.parse(msg.mentions)).toEqual([]);
    db.close();
  });

  it("stores broadcast sentinel for @all", () => {
    const db = setupDb();
    const msg = sendMessage(db, "agent-a", "coordination", "@all heads up");

    expect(JSON.parse(msg.mentions)).toEqual(["*"]);
    db.close();
  });

  it("drops invalid mentions silently", () => {
    const db = setupDb();
    const msg = sendMessage(db, "agent-a", "coordination", "@nonexistent hello");

    expect(JSON.parse(msg.mentions)).toEqual([]);
    db.close();
  });

  it("stores broadcast sentinel for @here", () => {
    const db = setupDb();
    const msg = sendMessage(db, "agent-a", "coordination", "@here attention please");

    expect(JSON.parse(msg.mentions)).toEqual(["*"]);
    db.close();
  });

  it("readMessages returns mentions field on messages", () => {
    const db = setupDb();
    registerAgent(db, "reviewer");
    sendMessage(db, "agent-a", "coordination", "@reviewer please look");

    const messages = readMessages(db, "reviewer", "coordination");
    expect(messages.length).toBe(1);
    expect(JSON.parse(messages[0]!.mentions)).toEqual(["reviewer"]);
    db.close();
  });
});
