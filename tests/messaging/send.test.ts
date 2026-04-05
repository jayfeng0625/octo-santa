import { describe, it, expect, afterEach } from "bun:test";
import { allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { MessagingService } from "../../src/core/messaging/service";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";

const TEST_DB = testDbPath("send");

function setup() {
  const db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid);
  return { db, svc };
}

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("sendMessage", () => {
  it("sends a message and returns the message with an ID", () => {
    const { db, svc } = setup();
    svc.register("octo-santa");
    svc.createChannel("octo-santa", "coordination");
    const msg = svc.send("octo-santa", "coordination", "Hello world");

    expect(msg.id).toBeGreaterThan(0);
    expect(msg.agent_id).toBe("octo-santa");
    expect(msg.content).toBe("Hello world");
    expect(msg.created_at).toBeGreaterThan(0);

    db.close();
  });

  it("messages get sequential IDs", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-a", "general");
    const msg1 = svc.send("agent-a", "general", "First");
    const msg2 = svc.send("agent-b", "general", "Second");

    expect(msg2.id).toBeGreaterThan(msg1.id);

    db.close();
  });

  it("updates agent last_seen_at on send", () => {
    const { db, svc } = setup();
    const before = svc.register("octo-santa");
    svc.createChannel("octo-santa", "general");
    svc.send("octo-santa", "general", "ping");
    const after = db.query("SELECT * FROM agents WHERE id = ?").get("octo-santa") as { last_seen_at: number };

    expect(after.last_seen_at).toBeGreaterThanOrEqual(before.last_seen_at);

    db.close();
  });

  it("stores parsed mentions in message", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("reviewer");
    svc.createChannel("agent-a", "coordination");
    const msg = svc.send("agent-a", "coordination", "@reviewer check this");

    expect(JSON.parse(msg.mentions)).toEqual(["reviewer"]);
    db.close();
  });

  it("stores empty array when no mentions", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.createChannel("agent-a", "coordination");
    const msg = svc.send("agent-a", "coordination", "just a message");

    expect(JSON.parse(msg.mentions)).toEqual([]);
    db.close();
  });

  it("stores broadcast sentinel for @all", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.createChannel("agent-a", "coordination");
    const msg = svc.send("agent-a", "coordination", "@all heads up");

    expect(JSON.parse(msg.mentions)).toEqual(["*"]);
    db.close();
  });

  it("drops invalid mentions silently", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.createChannel("agent-a", "coordination");
    const msg = svc.send("agent-a", "coordination", "@nonexistent hello");

    expect(JSON.parse(msg.mentions)).toEqual([]);
    db.close();
  });

  it("stores broadcast sentinel for @here", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.createChannel("agent-a", "coordination");
    const msg = svc.send("agent-a", "coordination", "@here attention please");

    expect(JSON.parse(msg.mentions)).toEqual(["*"]);
    db.close();
  });

  it("readMessages returns mentions field on messages", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("reviewer");
    // reviewer subscribes before message is sent so cursor starts at 0 (sees all messages)
    svc.createChannel("reviewer", "coordination");
    svc.subscribe("reviewer", "coordination");
    svc.send("agent-a", "coordination", "@reviewer please look");

    const messages = svc.read("reviewer", "coordination");
    expect(messages.length).toBe(1);
    expect(JSON.parse(messages[0]!.mentions)).toEqual(["reviewer"]);
    db.close();
  });

  it("throws when sending before registering", () => {
    const { db, svc } = setup();
    // Create channel via a registered agent first
    svc.register("setup-agent");
    svc.createChannel("setup-agent", "general");

    expect(() => svc.send("unregistered", "general", "hello")).toThrow(
      `Agent "unregistered" must call messaging_register before using messaging tools`
    );
    db.close();
  });

  it("throws when sending to non-existent channel", () => {
    const { db, svc } = setup();
    svc.register("agent-a");

    expect(() => svc.send("agent-a", "no-such-channel", "hello")).toThrow(
      `Channel "no-such-channel" does not exist`
    );
    db.close();
  });
});
