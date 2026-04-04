import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { createDb } from "../../src/db";
import { runMigrations } from "../../src/migrations";
import {
  messagingMigrations,
  registerAgent,
  sendMessage,
  readMessages,
  subscribeToChannel,
} from "../../src/modules/messaging/tools";

const TEST_DB = "/tmp/octo-santa-test-subscribe.sqlite";

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

afterEach(() => cleanupDb(TEST_DB));

describe("subscribeToChannel", () => {
  it("creates cursor at max message ID for new subscriber", () => {
    const db = setupDb();
    sendMessage(db, "agent-a", "planning", "msg one");
    sendMessage(db, "agent-a", "planning", "msg two");
    sendMessage(db, "agent-a", "planning", "msg three");

    subscribeToChannel(db, "jay", "planning");

    // Cursor should be at the latest message, so readMessages returns nothing
    const unread = readMessages(db, "jay", "planning");
    expect(unread).toHaveLength(0);
    db.close();
  });

  it("preserves existing cursor (does not lose unread backlog)", () => {
    const db = setupDb();
    sendMessage(db, "agent-a", "planning", "old msg");

    // jay subscribes and reads, setting cursor
    subscribeToChannel(db, "jay", "planning");
    readMessages(db, "jay", "planning");

    // New messages arrive while jay is away
    sendMessage(db, "agent-a", "planning", "new msg 1");
    sendMessage(db, "agent-a", "planning", "new msg 2");

    // Reconnect: subscribeToChannel should NOT advance cursor
    subscribeToChannel(db, "jay", "planning");

    // Unread messages should still be available
    const unread = readMessages(db, "jay", "planning");
    expect(unread).toHaveLength(2);
    expect(unread[0]!.content).toBe("new msg 1");
    db.close();
  });

  it("creates channel if it does not exist", () => {
    const db = setupDb();
    registerAgent(db, "jay");

    subscribeToChannel(db, "jay", "new-channel");

    // Channel exists and cursor is set
    const channels = db.query("SELECT * FROM channels WHERE name = ?").get("new-channel");
    expect(channels).not.toBeNull();
    db.close();
  });

  it("creates cursor at 0 for empty channel", () => {
    const db = setupDb();

    subscribeToChannel(db, "jay", "empty-channel");

    // readMessages returns nothing (channel is empty)
    const unread = readMessages(db, "jay", "empty-channel");
    expect(unread).toHaveLength(0);
    db.close();
  });
});
