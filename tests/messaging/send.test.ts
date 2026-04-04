import { describe, it, expect, afterEach } from "bun:test";
import {
  messagingMigrations,
  registerAgent,
  createChannel,
  sendMessage,
  readMessages,
  subscribe,
} from "../../src/modules/messaging/tools";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";

const TEST_DB = testDbPath("send");

function setupDb() {
  return setupTestDb(TEST_DB, messagingMigrations);
}

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("sendMessage", () => {
  it("sends a message and returns the message with an ID", () => {
    const db = setupDb();
    registerAgent(db, "octo-santa");
    createChannel(db, "coordination", "octo-santa");
    const msg = sendMessage(db, "octo-santa", "coordination", "Hello world");

    expect(msg.id).toBeGreaterThan(0);
    expect(msg.agent_id).toBe("octo-santa");
    expect(msg.content).toBe("Hello world");
    expect(msg.created_at).toBeGreaterThan(0);

    db.close();
  });

  it("messages get sequential IDs", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "general", "agent-a");
    const msg1 = sendMessage(db, "agent-a", "general", "First");
    const msg2 = sendMessage(db, "agent-b", "general", "Second");

    expect(msg2.id).toBeGreaterThan(msg1.id);

    db.close();
  });

  it("updates agent last_seen_at on send", () => {
    const db = setupDb();
    const before = registerAgent(db, "octo-santa");
    createChannel(db, "general", "octo-santa");
    sendMessage(db, "octo-santa", "general", "ping");
    const after = db.query("SELECT * FROM agents WHERE id = ?").get("octo-santa") as { last_seen_at: number };

    expect(after.last_seen_at).toBeGreaterThanOrEqual(before.last_seen_at);

    db.close();
  });

  it("stores parsed mentions in message", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    registerAgent(db, "reviewer");
    createChannel(db, "coordination", "agent-a");
    const msg = sendMessage(db, "agent-a", "coordination", "@reviewer check this");

    expect(JSON.parse(msg.mentions)).toEqual(["reviewer"]);
    db.close();
  });

  it("stores empty array when no mentions", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    createChannel(db, "coordination", "agent-a");
    const msg = sendMessage(db, "agent-a", "coordination", "just a message");

    expect(JSON.parse(msg.mentions)).toEqual([]);
    db.close();
  });

  it("stores broadcast sentinel for @all", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    createChannel(db, "coordination", "agent-a");
    const msg = sendMessage(db, "agent-a", "coordination", "@all heads up");

    expect(JSON.parse(msg.mentions)).toEqual(["*"]);
    db.close();
  });

  it("drops invalid mentions silently", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    createChannel(db, "coordination", "agent-a");
    const msg = sendMessage(db, "agent-a", "coordination", "@nonexistent hello");

    expect(JSON.parse(msg.mentions)).toEqual([]);
    db.close();
  });

  it("stores broadcast sentinel for @here", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    createChannel(db, "coordination", "agent-a");
    const msg = sendMessage(db, "agent-a", "coordination", "@here attention please");

    expect(JSON.parse(msg.mentions)).toEqual(["*"]);
    db.close();
  });

  it("readMessages returns mentions field on messages", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    registerAgent(db, "reviewer");
    // reviewer subscribes before message is sent so cursor starts at 0 (sees all messages)
    createChannel(db, "coordination", "reviewer");
    subscribe(db, "reviewer", "coordination");
    sendMessage(db, "agent-a", "coordination", "@reviewer please look");

    const messages = readMessages(db, "reviewer", "coordination");
    expect(messages.length).toBe(1);
    expect(JSON.parse(messages[0]!.mentions)).toEqual(["reviewer"]);
    db.close();
  });

  it("throws when sending before registering", () => {
    const db = setupDb();
    // Create channel via a registered agent first
    registerAgent(db, "setup-agent");
    createChannel(db, "general", "setup-agent");

    expect(() => sendMessage(db, "unregistered", "general", "hello")).toThrow(
      `Agent "unregistered" must call messaging_register before using messaging tools`
    );
    db.close();
  });

  it("throws when sending to non-existent channel", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");

    expect(() => sendMessage(db, "agent-a", "no-such-channel", "hello")).toThrow(
      `Channel "no-such-channel" does not exist`
    );
    db.close();
  });
});
