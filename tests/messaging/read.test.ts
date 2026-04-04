import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { createDb } from "../../src/db";
import { runMigrations } from "../../src/migrations";
import {
  messagingMigrations,
  sendMessage,
  readMessages,
  subscribeToChannel,
} from "../../src/modules/messaging/tools";
import type { Message } from "../../src/modules/messaging/types";

const TEST_DB = "/tmp/octo-santa-test-read.sqlite";

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

describe("readMessages", () => {
  it("returns all messages for a first-time reader", () => {
    const db = setupDb();
    // agent-b subscribes before messages are sent (cursor at 0, sees all history)
    subscribeToChannel(db, "agent-b", "general");
    sendMessage(db, "agent-a", "general", "Hello");
    sendMessage(db, "agent-a", "general", "World");

    const messages = readMessages(db, "agent-b", "general");
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toBe("Hello");
    expect(messages[1]!.content).toBe("World");

    db.close();
  });

  it("advances cursor — second read returns only new messages", () => {
    const db = setupDb();
    subscribeToChannel(db, "agent-b", "general");
    sendMessage(db, "agent-a", "general", "First");
    readMessages(db, "agent-b", "general");

    sendMessage(db, "agent-a", "general", "Second");
    const messages = readMessages(db, "agent-b", "general");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("Second");

    db.close();
  });

  it("returns empty array when no new messages", () => {
    const db = setupDb();
    subscribeToChannel(db, "agent-b", "general");
    sendMessage(db, "agent-a", "general", "Hello");
    readMessages(db, "agent-b", "general");

    const messages = readMessages(db, "agent-b", "general");
    expect(messages).toHaveLength(0);

    db.close();
  });

  it("each agent has independent cursors", () => {
    const db = setupDb();
    subscribeToChannel(db, "agent-b", "general");
    subscribeToChannel(db, "agent-c", "general");
    sendMessage(db, "agent-a", "general", "Hello");

    readMessages(db, "agent-b", "general");
    const messagesC = readMessages(db, "agent-c", "general");

    expect(messagesC).toHaveLength(1);

    db.close();
  });

  it("supports limit parameter", () => {
    const db = setupDb();
    subscribeToChannel(db, "agent-b", "general");
    for (let i = 0; i < 10; i++) {
      sendMessage(db, "agent-a", "general", `Message ${i}`);
    }

    const messages = readMessages(db, "agent-b", "general", { limit: 3 });
    expect(messages).toHaveLength(3);
    expect(messages[0]!.content).toBe("Message 0");

    db.close();
  });

  it("paginated reads advance cursor correctly across pages", () => {
    const db = setupDb();
    subscribeToChannel(db, "agent-b", "general");
    for (let i = 0; i < 6; i++) {
      sendMessage(db, "agent-a", "general", `Message ${i}`);
    }

    // Page 1: first 3
    const page1 = readMessages(db, "agent-b", "general", { limit: 3 });
    expect(page1).toHaveLength(3);
    expect(page1[0]!.content).toBe("Message 0");
    expect(page1[2]!.content).toBe("Message 2");

    // Page 2: next 3 — cursor should have advanced past page 1
    const page2 = readMessages(db, "agent-b", "general", { limit: 3 });
    expect(page2).toHaveLength(3);
    expect(page2[0]!.content).toBe("Message 3");
    expect(page2[2]!.content).toBe("Message 5");

    // Page 3: no more messages
    const page3 = readMessages(db, "agent-b", "general", { limit: 3 });
    expect(page3).toHaveLength(0);

    db.close();
  });

  it("supports before_id for history queries without advancing cursor", () => {
    const db = setupDb();
    subscribeToChannel(db, "agent-b", "general");
    sendMessage(db, "agent-a", "general", "Old");
    const mid = sendMessage(db, "agent-a", "general", "Middle");
    sendMessage(db, "agent-a", "general", "New");

    // First, read all to advance cursor
    readMessages(db, "agent-b", "general");

    // Query history — should not affect cursor
    const history = readMessages(db, "agent-b", "general", { before_id: mid.id + 1 });
    expect(history).toHaveLength(2);
    expect(history[0]!.content).toBe("Old");

    // Verify cursor unchanged — next read still returns empty
    sendMessage(db, "agent-a", "general", "After history query");
    const newMsgs = readMessages(db, "agent-b", "general");
    expect(newMsgs).toHaveLength(1);
    expect(newMsgs[0]!.content).toBe("After history query");

    db.close();
  });

  it("sender's cursor is advanced so they don't re-read their own message", () => {
    const db = setupDb();
    // agent-b subscribes first so they can see all messages from start
    subscribeToChannel(db, "agent-b", "general");
    sendMessage(db, "agent-a", "general", "Hello from A");

    // Agent A should not see their own message when reading
    const messages = readMessages(db, "agent-a", "general");
    expect(messages).toHaveLength(0);

    // But agent B should see it
    const messagesB = readMessages(db, "agent-b", "general");
    expect(messagesB).toHaveLength(1);
    expect(messagesB[0]!.content).toBe("Hello from A");

    db.close();
  });

  it("sender does not skip unread messages from others when sending", () => {
    const db = setupDb();
    // B sends first
    sendMessage(db, "agent-b", "general", "Message from B");
    // A sends without reading first
    sendMessage(db, "agent-a", "general", "Message from A");

    // A should still see B's message
    const messages = readMessages(db, "agent-a", "general");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("Message from B");

    db.close();
  });

  it("history reads also filter out own messages", () => {
    const db = setupDb();
    sendMessage(db, "agent-a", "general", "From A");
    sendMessage(db, "agent-b", "general", "From B");
    sendMessage(db, "agent-a", "general", "From A again");

    // agent-a has cursor via sendMessage, so before_id read works
    const history = readMessages(db, "agent-a", "general", { before_id: 999 });
    // Should only see B's message, not A's own
    expect(history).toHaveLength(1);
    expect(history[0]!.content).toBe("From B");

    db.close();
  });

  it("throws for nonexistent channel", () => {
    const db = setupDb();
    expect(() => readMessages(db, "agent-a", "no-such-channel")).toThrow(
      'Channel "no-such-channel" does not exist. Use messaging_create_channel to create it first.'
    );
    db.close();
  });

  it("creates cursor row on first read even if no messages exist", () => {
    const db = setupDb();
    subscribeToChannel(db, "agent-b", "general");
    sendMessage(db, "agent-a", "general", "setup"); // creates channel (already exists)
    readMessages(db, "agent-a", "general"); // agent-a reads (sees nothing, own messages filtered)

    // Agent B reads and reads again
    readMessages(db, "agent-b", "general");
    readMessages(db, "agent-b", "general");

    const cursor = db.query(
      "SELECT * FROM cursors WHERE agent_id = ? AND channel_id = (SELECT id FROM channels WHERE name = ?)"
    ).get("agent-b", "general");
    expect(cursor).not.toBeNull();

    db.close();
  });

  it("throws when reading without cursor (access control)", () => {
    const db = setupDb();
    // Create channel via sendMessage (agent-a has cursor)
    sendMessage(db, "agent-a", "secret", "hello");

    // agent-b has no cursor — should throw
    expect(() => readMessages(db, "agent-b", "secret")).toThrow("Not a member");

    db.close();
  });
});
