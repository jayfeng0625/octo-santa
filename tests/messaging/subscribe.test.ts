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

const TEST_DB = testDbPath("subscribe");

function setupDb() {
  return setupTestDb(TEST_DB, messagingMigrations);
}

afterEach(() => cleanupDb(TEST_DB));

describe("subscribe", () => {
  it("creates cursor at max message ID for new subscriber", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    createChannel(db, "planning", "agent-a");
    sendMessage(db, "agent-a", "planning", "msg one");
    sendMessage(db, "agent-a", "planning", "msg two");
    sendMessage(db, "agent-a", "planning", "msg three");

    registerAgent(db, "jay");
    subscribe(db, "jay", "planning");

    // Cursor should be at the latest message, so readMessages returns nothing
    const unread = readMessages(db, "jay", "planning");
    expect(unread).toHaveLength(0);
    db.close();
  });

  it("preserves existing cursor (does not lose unread backlog)", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    createChannel(db, "planning", "agent-a");
    sendMessage(db, "agent-a", "planning", "old msg");

    // jay subscribes and reads, setting cursor
    registerAgent(db, "jay");
    subscribe(db, "jay", "planning");
    readMessages(db, "jay", "planning");

    // New messages arrive while jay is away
    sendMessage(db, "agent-a", "planning", "new msg 1");
    sendMessage(db, "agent-a", "planning", "new msg 2");

    // Reconnect: subscribe should NOT advance cursor
    subscribe(db, "jay", "planning");

    // Unread messages should still be available
    const unread = readMessages(db, "jay", "planning");
    expect(unread).toHaveLength(2);
    expect(unread[0]!.content).toBe("new msg 1");
    db.close();
  });

  it("subscribe to non-existent channel throws error", () => {
    const db = setupDb();
    registerAgent(db, "jay");

    expect(() => subscribe(db, "jay", "no-such-channel")).toThrow(
      `Channel "no-such-channel" does not exist`
    );
    db.close();
  });

  it("double-subscribe is idempotent (no error, cursor preserved)", () => {
    const db = setupDb();
    registerAgent(db, "jay");
    registerAgent(db, "agent-a");
    createChannel(db, "my-channel", "jay");

    subscribe(db, "jay", "my-channel");
    sendMessage(db, "agent-a", "my-channel", "message after first subscribe");

    // Second subscribe should not throw and should not advance cursor
    expect(() => subscribe(db, "jay", "my-channel")).not.toThrow();

    // Cursor still sees the unread message
    const unread = readMessages(db, "jay", "my-channel");
    expect(unread).toHaveLength(1);
    expect(unread[0]!.content).toBe("message after first subscribe");
    db.close();
  });

  it("subscribe before register throws error", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    createChannel(db, "planning", "agent-a");
    sendMessage(db, "agent-a", "planning", "msg");
    // jay is NOT registered

    expect(() => subscribe(db, "jay", "planning")).toThrow(
      `Agent "jay" must call messaging_register before using messaging tools`
    );
    db.close();
  });
});
