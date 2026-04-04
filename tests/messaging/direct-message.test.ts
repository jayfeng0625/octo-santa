import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { createDb } from "../../src/db";
import { runMigrations } from "../../src/migrations";
import {
  messagingMigrations,
  registerAgent,
  directMessage,
  readMessages,
} from "../../src/modules/messaging/tools";
import { brainMigrations } from "../../src/modules/brain/tools";

const TEST_DB = `/tmp/octo-santa-test-dm-${process.pid}.sqlite`;

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = path + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
}

function setupDb() {
  cleanupDb(TEST_DB);
  const db = createDb(TEST_DB);
  runMigrations(db, [...messagingMigrations, ...brainMigrations]);
  return db;
}

afterEach(() => { cleanupDb(TEST_DB); });

describe("directMessage", () => {
  it("creates deterministic channel name (sorted agent IDs)", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");

    directMessage(db, "agent-a", "agent-b", "hello");

    const channels = db.query("SELECT name FROM channels").all() as { name: string }[];
    expect(channels).toHaveLength(1);
    // Sorted: agent-a < agent-b lexicographically
    expect(channels[0]!.name).toBe("agent-a,agent-b");

    db.close();
  });

  it("both agents subscribed (have cursors) after DM", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");

    directMessage(db, "agent-a", "agent-b", "hello");

    // Both agents should be able to readMessages without error
    expect(() => readMessages(db, "agent-a", "agent-a,agent-b")).not.toThrow();
    expect(() => readMessages(db, "agent-b", "agent-a,agent-b")).not.toThrow();

    db.close();
  });

  it("idempotent — second DM reuses channel", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");

    directMessage(db, "agent-a", "agent-b", "first");
    directMessage(db, "agent-a", "agent-b", "second");

    const channels = db.query("SELECT name FROM channels").all() as { name: string }[];
    expect(channels).toHaveLength(1);

    db.close();
  });

  it("DM to self throws 'Cannot DM yourself'", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");

    expect(() => directMessage(db, "agent-a", "agent-a", "hello")).toThrow("Cannot DM yourself");

    db.close();
  });

  it("DM to nonexistent agent throws 'not found'", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");

    expect(() => directMessage(db, "agent-a", "agent-z", "hello")).toThrow("not found");

    db.close();
  });

  it("channel in DM mode — only 2 cursors exist", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");

    directMessage(db, "agent-a", "agent-b", "hello");

    const channel = db.query("SELECT id FROM channels WHERE name = ?").get("agent-a,agent-b") as { id: number };
    const cursors = db.query("SELECT * FROM cursors WHERE channel_id = ?").all(channel.id) as unknown[];
    expect(cursors).toHaveLength(2);

    db.close();
  });
});
