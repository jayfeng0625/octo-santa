import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { createDb } from "../../src/db";
import { runMigrations } from "../../src/migrations";
import {
  messagingMigrations,
  registerAgent,
  createChannel,
  subscribe,
  renameChannel,
} from "../../src/modules/messaging/tools";
import type { Message } from "../../src/modules/messaging/types";

const TEST_DB = "/tmp/octo-santa-test-rename.sqlite";

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

describe("renameChannel", () => {
  it("member renames channel — success, name updated", () => {
    const db = setupDb();
    registerAgent(db, "alice");
    createChannel(db, "old-name", "alice");
    subscribe(db, "alice", "old-name");

    const result = renameChannel(db, "alice", "old-name", "new-name");

    expect(result.name).toBe("new-name");
    expect(result.id).toBeGreaterThan(0);

    // Verify in DB
    const row = db.query("SELECT name FROM channels WHERE name = ?").get("new-name") as { name: string } | null;
    expect(row).not.toBeNull();
    expect(row!.name).toBe("new-name");

    // Old name gone
    const oldRow = db.query("SELECT name FROM channels WHERE name = ?").get("old-name") as unknown;
    expect(oldRow).toBeNull();

    db.close();
  });

  it("non-member rename throws an error", () => {
    const db = setupDb();
    registerAgent(db, "alice");
    registerAgent(db, "bob");
    createChannel(db, "my-channel", "alice");
    subscribe(db, "alice", "my-channel");

    expect(() => renameChannel(db, "bob", "my-channel", "renamed")).toThrow(
      `Not a member of channel "my-channel"`
    );

    db.close();
  });

  it("new name already exists throws an error", () => {
    const db = setupDb();
    registerAgent(db, "alice");
    createChannel(db, "channel-a", "alice");
    subscribe(db, "alice", "channel-a");
    createChannel(db, "channel-b", "alice");
    subscribe(db, "alice", "channel-b");

    expect(() => renameChannel(db, "alice", "channel-a", "channel-b")).toThrow(
      `Channel "channel-b" already exists`
    );

    db.close();
  });

  it("channel not found throws an error", () => {
    const db = setupDb();
    registerAgent(db, "alice");

    expect(() => renameChannel(db, "alice", "nonexistent", "new-name")).toThrow(
      `Channel "nonexistent" not found`
    );

    db.close();
  });

  it("unregistered agent throws an error", () => {
    const db = setupDb();
    // alice is not registered (no registerAgent call)
    // We need to create a channel and cursor via another agent first
    registerAgent(db, "bob");
    createChannel(db, "some-channel", "bob");
    subscribe(db, "bob", "some-channel");

    // alice doesn't exist in agents table at all — requireRegistered should throw
    expect(() => renameChannel(db, "alice", "some-channel", "renamed")).toThrow(
      `Agent "alice" must call messaging_register before using messaging tools`
    );

    db.close();
  });

  it("rename sends @all notification message to channel members", () => {
    const db = setupDb();
    registerAgent(db, "alice");
    createChannel(db, "old-name", "alice");
    subscribe(db, "alice", "old-name");

    renameChannel(db, "alice", "old-name", "new-name");

    // Look up the channel by new name
    const channel = db.query("SELECT id FROM channels WHERE name = ?").get("new-name") as { id: number };
    const messages = db.query("SELECT * FROM messages WHERE channel_id = ?").all(channel.id) as Message[];

    expect(messages.length).toBe(1);
    expect(JSON.parse(messages[0]!.mentions)).toEqual(["*"]);

    db.close();
  });

  it("notification message content includes old and new name", () => {
    const db = setupDb();
    registerAgent(db, "alice");
    createChannel(db, "project-alpha", "alice");
    subscribe(db, "alice", "project-alpha");

    renameChannel(db, "alice", "project-alpha", "project-beta");

    const channel = db.query("SELECT id FROM channels WHERE name = ?").get("project-beta") as { id: number };
    const messages = db.query("SELECT * FROM messages WHERE channel_id = ?").all(channel.id) as Message[];

    expect(messages.length).toBe(1);
    expect(messages[0]!.content).toContain("project-alpha");
    expect(messages[0]!.content).toContain("project-beta");

    db.close();
  });

  it("empty new name throws an error", () => {
    const db = setupDb();
    registerAgent(db, "alice");
    createChannel(db, "my-channel", "alice");
    subscribe(db, "alice", "my-channel");

    expect(() => renameChannel(db, "alice", "my-channel", "   ")).toThrow(
      "new channel name must not be empty"
    );

    db.close();
  });
});
