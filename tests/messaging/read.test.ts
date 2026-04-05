import { describe, it, expect, afterEach } from "bun:test";
import { allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { MessagingService } from "../../src/core/messaging/service";
import type { Message } from "../../src/core/messaging/types";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";

const TEST_DB = testDbPath("read");

function setup() {
  const db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid);
  return { db, svc };
}

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("readMessages", () => {
  it("returns all messages for a first-time reader", () => {
    const { db, svc } = setup();
    // agent-b subscribes before messages are sent (cursor at 0, sees all history)
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "general");
    svc.subscribe("agent-b", "general");
    svc.send("agent-a", "general", "Hello");
    svc.send("agent-a", "general", "World");

    const messages = svc.read("agent-b", "general");
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toBe("Hello");
    expect(messages[1]!.content).toBe("World");

    db.close();
  });

  it("advances cursor — second read returns only new messages", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "general");
    svc.subscribe("agent-b", "general");
    svc.send("agent-a", "general", "First");
    svc.read("agent-b", "general");

    svc.send("agent-a", "general", "Second");
    const messages = svc.read("agent-b", "general");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("Second");

    db.close();
  });

  it("returns empty array when no new messages", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "general");
    svc.subscribe("agent-b", "general");
    svc.send("agent-a", "general", "Hello");
    svc.read("agent-b", "general");

    const messages = svc.read("agent-b", "general");
    expect(messages).toHaveLength(0);

    db.close();
  });

  it("each agent has independent cursors", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.register("agent-c");
    svc.createChannel("agent-b", "general");
    svc.subscribe("agent-b", "general");
    svc.subscribe("agent-c", "general");
    svc.send("agent-a", "general", "Hello");

    svc.read("agent-b", "general");
    const messagesC = svc.read("agent-c", "general");

    expect(messagesC).toHaveLength(1);

    db.close();
  });

  it("supports limit parameter", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "general");
    svc.subscribe("agent-b", "general");
    for (let i = 0; i < 10; i++) {
      svc.send("agent-a", "general", `Message ${i}`);
    }

    const messages = svc.read("agent-b", "general", { limit: 3 });
    expect(messages).toHaveLength(3);
    expect(messages[0]!.content).toBe("Message 0");

    db.close();
  });

  it("paginated reads advance cursor correctly across pages", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "general");
    svc.subscribe("agent-b", "general");
    for (let i = 0; i < 6; i++) {
      svc.send("agent-a", "general", `Message ${i}`);
    }

    // Page 1: first 3
    const page1 = svc.read("agent-b", "general", { limit: 3 });
    expect(page1).toHaveLength(3);
    expect(page1[0]!.content).toBe("Message 0");
    expect(page1[2]!.content).toBe("Message 2");

    // Page 2: next 3 — cursor should have advanced past page 1
    const page2 = svc.read("agent-b", "general", { limit: 3 });
    expect(page2).toHaveLength(3);
    expect(page2[0]!.content).toBe("Message 3");
    expect(page2[2]!.content).toBe("Message 5");

    // Page 3: no more messages
    const page3 = svc.read("agent-b", "general", { limit: 3 });
    expect(page3).toHaveLength(0);

    db.close();
  });

  it("supports before_id for history queries without advancing cursor", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "general");
    svc.subscribe("agent-b", "general");
    svc.send("agent-a", "general", "Old");
    const mid = svc.send("agent-a", "general", "Middle");
    svc.send("agent-a", "general", "New");

    // First, read all to advance cursor
    svc.read("agent-b", "general");

    // Query history — should not affect cursor
    const history = svc.read("agent-b", "general", { before_id: mid.id + 1 });
    expect(history).toHaveLength(2);
    expect(history[0]!.content).toBe("Old");

    // Verify cursor unchanged — next read still returns empty
    svc.send("agent-a", "general", "After history query");
    const newMsgs = svc.read("agent-b", "general");
    expect(newMsgs).toHaveLength(1);
    expect(newMsgs[0]!.content).toBe("After history query");

    db.close();
  });

  it("sender's cursor is advanced so they don't re-read their own message", () => {
    const { db, svc } = setup();
    // agent-b subscribes first so they can see all messages from start
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "general");
    svc.subscribe("agent-b", "general");
    svc.send("agent-a", "general", "Hello from A");

    // Agent A should not see their own message when reading
    const messages = svc.read("agent-a", "general");
    expect(messages).toHaveLength(0);

    // But agent B should see it
    const messagesB = svc.read("agent-b", "general");
    expect(messagesB).toHaveLength(1);
    expect(messagesB[0]!.content).toBe("Hello from A");

    db.close();
  });

  it("sender does not skip unread messages from others when sending", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-a", "general");
    // B sends first
    svc.send("agent-b", "general", "Message from B");
    // A sends without reading first
    svc.send("agent-a", "general", "Message from A");

    // A should still see B's message
    const messages = svc.read("agent-a", "general");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("Message from B");

    db.close();
  });

  it("history reads also filter out own messages", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-a", "general");
    svc.send("agent-a", "general", "From A");
    svc.send("agent-b", "general", "From B");
    svc.send("agent-a", "general", "From A again");

    // agent-a has cursor via send, so before_id read works
    const history = svc.read("agent-a", "general", { before_id: 999 });
    // Should only see B's message, not A's own
    expect(history).toHaveLength(1);
    expect(history[0]!.content).toBe("From B");

    db.close();
  });

  it("throws for nonexistent channel", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    expect(() => svc.read("agent-a", "no-such-channel")).toThrow(
      'Channel "no-such-channel" does not exist'
    );
    db.close();
  });

  it("creates cursor row on first read even if no messages exist", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "general");
    svc.subscribe("agent-b", "general");
    svc.send("agent-a", "general", "setup");
    svc.read("agent-a", "general"); // agent-a reads (sees nothing, own messages filtered)

    // Agent B reads and reads again
    svc.read("agent-b", "general");
    svc.read("agent-b", "general");

    const cursor = db.query(
      "SELECT * FROM cursors WHERE agent_id = ? AND channel_id = (SELECT id FROM channels WHERE name = ?)"
    ).get("agent-b", "general");
    expect(cursor).not.toBeNull();

    db.close();
  });

  it("throws when reading without cursor (access control)", () => {
    const { db, svc } = setup();
    // Create channel via a registered agent (agent-a has cursor)
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-a", "secret");
    svc.send("agent-a", "secret", "hello");

    // agent-b has no cursor — should throw
    expect(() => svc.read("agent-b", "secret")).toThrow("Not a member");

    db.close();
  });

  it("throws when reading before registering", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.createChannel("agent-a", "general");
    svc.send("agent-a", "general", "hello");

    expect(() => svc.read("unregistered", "general")).toThrow(
      `Agent "unregistered" must call messaging_register before using messaging tools`
    );
    db.close();
  });
});
