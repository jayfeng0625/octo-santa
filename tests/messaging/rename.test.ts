import { describe, it, expect, afterEach } from "bun:test";
import { allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { MessagingService } from "../../src/core/messaging/service";
import type { Message } from "../../src/core/messaging/types";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";

const TEST_DB = testDbPath("rename");

function setup() {
  const db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid);
  return { db, svc };
}

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("renameChannel", () => {
  it("member renames channel — success, name updated", () => {
    const { db, svc } = setup();
    svc.register("alice");
    svc.createChannel("alice", "old-name");
    svc.subscribe("alice", "old-name");

    const result = svc.renameChannel("alice", "old-name", "new-name");

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
    const { db, svc } = setup();
    svc.register("alice");
    svc.register("bob");
    svc.createChannel("alice", "my-channel");
    svc.subscribe("alice", "my-channel");

    expect(() => svc.renameChannel("bob", "my-channel", "renamed")).toThrow(
      `Not a member of channel "my-channel"`
    );

    db.close();
  });

  it("new name already exists throws an error", () => {
    const { db, svc } = setup();
    svc.register("alice");
    svc.createChannel("alice", "channel-a");
    svc.subscribe("alice", "channel-a");
    svc.createChannel("alice", "channel-b");
    svc.subscribe("alice", "channel-b");

    expect(() => svc.renameChannel("alice", "channel-a", "channel-b")).toThrow(
      `Channel "channel-b" already exists`
    );

    db.close();
  });

  it("channel not found throws an error", () => {
    const { db, svc } = setup();
    svc.register("alice");

    expect(() => svc.renameChannel("alice", "nonexistent", "new-name")).toThrow(
      `Channel "nonexistent" not found`
    );

    db.close();
  });

  it("unregistered agent throws an error", () => {
    const { db, svc } = setup();
    // alice is not registered (no register call)
    // We need to create a channel and cursor via another agent first
    svc.register("bob");
    svc.createChannel("bob", "some-channel");
    svc.subscribe("bob", "some-channel");

    // alice doesn't exist in agents table at all — requireRegistered should throw
    expect(() => svc.renameChannel("alice", "some-channel", "renamed")).toThrow(
      `Agent "alice" must call messaging_register before using messaging tools`
    );

    db.close();
  });

  it("rename sends @all notification message to channel members", () => {
    const { db, svc } = setup();
    svc.register("alice");
    svc.createChannel("alice", "old-name");
    svc.subscribe("alice", "old-name");

    svc.renameChannel("alice", "old-name", "new-name");

    // Look up the channel by new name
    const channel = db.query("SELECT id FROM channels WHERE name = ?").get("new-name") as { id: number };
    const messages = db.query("SELECT * FROM messages WHERE channel_id = ?").all(channel.id) as Message[];

    expect(messages.length).toBe(1);
    expect(JSON.parse(messages[0]!.mentions)).toEqual(["*"]);

    db.close();
  });

  it("notification message content includes old and new name", () => {
    const { db, svc } = setup();
    svc.register("alice");
    svc.createChannel("alice", "project-alpha");
    svc.subscribe("alice", "project-alpha");

    svc.renameChannel("alice", "project-alpha", "project-beta");

    const channel = db.query("SELECT id FROM channels WHERE name = ?").get("project-beta") as { id: number };
    const messages = db.query("SELECT * FROM messages WHERE channel_id = ?").all(channel.id) as Message[];

    expect(messages.length).toBe(1);
    expect(messages[0]!.content).toContain("project-alpha");
    expect(messages[0]!.content).toContain("project-beta");

    db.close();
  });

  it("empty new name throws an error", () => {
    const { db, svc } = setup();
    svc.register("alice");
    svc.createChannel("alice", "my-channel");
    svc.subscribe("alice", "my-channel");

    expect(() => svc.renameChannel("alice", "my-channel", "   ")).toThrow(
      "new channel name must not be empty"
    );

    db.close();
  });
});
