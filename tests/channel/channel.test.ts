// tests/channel/channel.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  messagingMigrations,
  registerAgent,
  createChannel,
  subscribe,
  sendMessage,
  readMessages,
  unregisterAgent,
  PID_STALE_MS,
} from "../../src/modules/messaging/tools";
import { startPolling, type NotifyFn } from "../../src/channel";
import type { Database } from "bun:sqlite";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";

let TEST_DB: string;
let db: Database;

const sleep = Bun.sleep;

const FAST_INTERVAL = 50;

beforeEach(() => {
  TEST_DB = testDbPath("channel");
  db = setupTestDb(TEST_DB, messagingMigrations);
});

afterEach(() => {
  try { db.close(); } catch {}
  cleanupDb(TEST_DB);
});

describe("startPolling", () => {
  it("finds unread messages and calls notify with correct format", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "coordination", "agent-b");
    sendMessage(db, "agent-b", "coordination", "hello from b");
    subscribe(db, "agent-a", "coordination");
    readMessages(db, "agent-a", "coordination");
    sendMessage(db, "agent-b", "coordination", "@agent-a second msg");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const notify: NotifyFn = async (content, meta) => {
      notifications.push({ content, meta });
    };

    const stop = startPolling(db, "agent-a", notify, FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(1);
    expect(notifications[0]!.content).toBe("@agent-a second msg");
    expect(notifications[0]!.meta.channel_name).toBe("coordination");
    expect(notifications[0]!.meta.sender).toBe("agent-b");
    expect(notifications[0]!.meta.message_id).toBeDefined();
  });

  it("skips messages sent by the subscribing agent (self-exclusion)", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "coordination", "agent-b");
    sendMessage(db, "agent-b", "coordination", "setup");
    subscribe(db, "agent-a", "coordination");
    readMessages(db, "agent-a", "coordination");
    sendMessage(db, "agent-a", "coordination", "my own message");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(0);
  });

  it("does nothing when agent has no cursors", async () => {
    registerAgent(db, "agent-a");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(0);
  });

  it("does nothing when there are no unread messages", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "coordination", "agent-b");
    sendMessage(db, "agent-b", "coordination", "hello");
    subscribe(db, "agent-a", "coordination");
    readMessages(db, "agent-a", "coordination");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(0);
  });

  it("does NOT advance cursors on push", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "coordination", "agent-b");
    sendMessage(db, "agent-b", "coordination", "first");
    subscribe(db, "agent-a", "coordination");
    readMessages(db, "agent-a", "coordination");
    sendMessage(db, "agent-b", "coordination", "second");

    const channel = db.query("SELECT id FROM channels WHERE name = ?").get("coordination") as { id: number };
    const cursorBefore = db.query(
      "SELECT last_read_message_id FROM cursors WHERE agent_id = ? AND channel_id = ?"
    ).get("agent-a", channel.id) as { last_read_message_id: number };

    const stop = startPolling(db, "agent-a", async () => {}, FAST_INTERVAL);
    await sleep(200);
    await stop();

    const cursorAfter = db.query(
      "SELECT last_read_message_id FROM cursors WHERE agent_id = ? AND channel_id = ?"
    ).get("agent-a", channel.id) as { last_read_message_id: number };

    expect(cursorAfter.last_read_message_id).toBe(cursorBefore.last_read_message_id);
  });

  it("does not notify the same message twice across poll cycles", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "coordination", "agent-b");
    sendMessage(db, "agent-b", "coordination", "setup");
    subscribe(db, "agent-a", "coordination");
    readMessages(db, "agent-a", "coordination");
    sendMessage(db, "agent-b", "coordination", "@agent-a hello");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(300);
    await stop();

    expect(notifications.length).toBe(1);
  });

  it("initializes lastPushedId from cursor position (no historical flood)", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "coordination", "agent-b");
    sendMessage(db, "agent-b", "coordination", "first");
    sendMessage(db, "agent-b", "coordination", "second");
    sendMessage(db, "agent-b", "coordination", "third");
    subscribe(db, "agent-a", "coordination");
    readMessages(db, "agent-a", "coordination");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(0);
  });

  it("picks up new cursor mid-session without flooding history", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "coordination", "agent-b");
    sendMessage(db, "agent-b", "coordination", "coord msg");
    subscribe(db, "agent-a", "coordination");
    readMessages(db, "agent-a", "coordination");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(100);

    createChannel(db, "frontend", "agent-b");
    sendMessage(db, "agent-b", "frontend", "old frontend msg");
    subscribe(db, "agent-a", "frontend");
    readMessages(db, "agent-a", "frontend");
    sendMessage(db, "agent-b", "frontend", "@agent-a new frontend msg");

    await sleep(200);
    await stop();

    const frontendNotifs = notifications.filter((n) => n.meta.channel_name === "frontend");
    expect(frontendNotifs.length).toBe(1);
    expect(frontendNotifs[0]!.content).toBe("@agent-a new frontend msg");
  });

  it("coalesces multiple unread messages on same channel into one notification", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "coordination", "agent-b");
    sendMessage(db, "agent-b", "coordination", "setup");
    subscribe(db, "agent-a", "coordination");
    readMessages(db, "agent-a", "coordination");
    sendMessage(db, "agent-b", "coordination", "@agent-a first");
    sendMessage(db, "agent-b", "coordination", "second");
    sendMessage(db, "agent-b", "coordination", "third");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(1);
    expect(notifications[0]!.content).toContain("3 new messages");
    expect(notifications[0]!.content).toContain("third");
  });

  it("does not advance watermark when notify fails", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "coordination", "agent-b");
    sendMessage(db, "agent-b", "coordination", "setup");
    subscribe(db, "agent-a", "coordination");
    readMessages(db, "agent-a", "coordination");
    sendMessage(db, "agent-b", "coordination", "@agent-a hello");

    let callCount = 0;
    const notify: NotifyFn = async () => {
      callCount++;
      if (callCount === 1) throw new Error("simulated failure");
    };

    const stop = startPolling(db, "agent-a", notify, FAST_INTERVAL);
    await sleep(300);
    await stop();

    expect(callCount).toBe(2);
  });

  it("does not run concurrent ticks (serialization)", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "coordination", "agent-b");
    sendMessage(db, "agent-b", "coordination", "setup");
    subscribe(db, "agent-a", "coordination");
    readMessages(db, "agent-a", "coordination");
    sendMessage(db, "agent-b", "coordination", "@agent-a unread");

    let concurrentCount = 0;
    let maxConcurrent = 0;
    const notify: NotifyFn = async () => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await sleep(80);
      concurrentCount--;
    };

    const stop = startPolling(db, "agent-a", notify, 10);
    await sleep(500);
    await stop();

    expect(maxConcurrent).toBe(1);
  });

  it("stop() waits for in-flight tick to complete (quiescent shutdown)", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "coordination", "agent-b");
    sendMessage(db, "agent-b", "coordination", "setup");
    subscribe(db, "agent-a", "coordination");
    readMessages(db, "agent-a", "coordination");
    sendMessage(db, "agent-b", "coordination", "@agent-a unread");

    let notifyStarted = false;
    let notifyFinished = false;
    const notify: NotifyFn = async () => {
      notifyStarted = true;
      await sleep(150);
      notifyFinished = true;
    };

    const stop = startPolling(db, "agent-a", notify, 1);
    await sleep(20); // Let first tick start
    await stop(); // Should wait for notify to finish

    expect(notifyStarted).toBe(true);
    expect(notifyFinished).toBe(true);
  });

  it("coalesces more than 10 unread messages into a single notification", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "coordination", "agent-b");
    sendMessage(db, "agent-b", "coordination", "setup");
    subscribe(db, "agent-a", "coordination");
    readMessages(db, "agent-a", "coordination");
    for (let i = 1; i <= 15; i++) {
      sendMessage(db, "agent-b", "coordination", i === 1 ? `@agent-a msg-${i}` : `msg-${i}`);
    }

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(1);
    expect(notifications[0]!.content).toContain("15 new messages");
    expect(notifications[0]!.content).toContain("msg-15");
  });

  it("updates agent last_seen_at on each poll tick (heartbeat)", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "coordination", "agent-b");
    sendMessage(db, "agent-b", "coordination", "setup");
    subscribe(db, "agent-a", "coordination");
    readMessages(db, "agent-a", "coordination");

    const before = db.query("SELECT last_seen_at FROM agents WHERE id = ?")
      .get("agent-a") as { last_seen_at: number };

    const stop = startPolling(db, "agent-a", async () => {}, FAST_INTERVAL);
    await sleep(200);
    await stop();

    const after = db.query("SELECT last_seen_at FROM agents WHERE id = ?")
      .get("agent-a") as { last_seen_at: number };

    expect(after.last_seen_at).toBeGreaterThanOrEqual(before.last_seen_at);
  });

  it("does NOT push messages without mentions in group mode (3+ members)", async () => {
    // Create a channel with 3 registered (PID-bearing) members
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    registerAgent(db, "agent-c");
    createChannel(db, "group-ch", "agent-b");
    sendMessage(db, "agent-b", "group-ch", "setup");
    subscribe(db, "agent-a", "group-ch");
    readMessages(db, "agent-a", "group-ch");
    subscribe(db, "agent-c", "group-ch");
    readMessages(db, "agent-c", "group-ch");  // 3rd member

    // agent-b sends a message without mentions
    sendMessage(db, "agent-b", "group-ch", "just a message, no mentions");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(0);
  });

  it("pushes to mentioned agent in group mode", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    registerAgent(db, "agent-c");
    createChannel(db, "group-ch", "agent-b");
    sendMessage(db, "agent-b", "group-ch", "setup");
    subscribe(db, "agent-a", "group-ch");
    readMessages(db, "agent-a", "group-ch");
    subscribe(db, "agent-c", "group-ch");
    readMessages(db, "agent-c", "group-ch");  // 3rd member

    sendMessage(db, "agent-b", "group-ch", "@agent-a check this");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(1);
    expect(notifications[0]!.content).toBe("@agent-a check this");
  });

  it("does NOT push to unmentioned agent in group mode", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    registerAgent(db, "agent-c");
    createChannel(db, "group-ch", "agent-b");
    sendMessage(db, "agent-b", "group-ch", "setup");
    subscribe(db, "agent-a", "group-ch");
    readMessages(db, "agent-a", "group-ch");
    subscribe(db, "agent-c", "group-ch");
    readMessages(db, "agent-c", "group-ch");  // 3rd member

    sendMessage(db, "agent-b", "group-ch", "@agent-c only for you");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(0);
  });

  it("pushes @all messages to all subscribers in group mode", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    registerAgent(db, "agent-c");
    createChannel(db, "group-ch", "agent-b");
    sendMessage(db, "agent-b", "group-ch", "setup");
    subscribe(db, "agent-a", "group-ch");
    readMessages(db, "agent-a", "group-ch");
    subscribe(db, "agent-c", "group-ch");
    readMessages(db, "agent-c", "group-ch");  // 3rd member

    sendMessage(db, "agent-b", "group-ch", "@all deploying now");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(1);
    expect(notifications[0]!.content).toBe("@all deploying now");
  });

  it("auto-notifies in DM mode (2 members, no mention needed)", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "agent-a,agent-b", "agent-b");
    sendMessage(db, "agent-b", "agent-a,agent-b", "setup");
    subscribe(db, "agent-a", "agent-a,agent-b");
    readMessages(db, "agent-a", "agent-a,agent-b");
    // Only 2 members: agent-a and agent-b, DM format channel name

    sendMessage(db, "agent-b", "agent-a,agent-b", "hey, no mention here");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(1);
    expect(notifications[0]!.content).toBe("hey, no mention here");
  });

  it("non-DM channel with 2 members behaves as group (requires mentions)", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "evolve-ch", "agent-b");
    sendMessage(db, "agent-b", "evolve-ch", "setup");
    subscribe(db, "agent-a", "evolve-ch");
    readMessages(db, "agent-a", "evolve-ch");
    // 2 members but channel name is NOT DM format — group channel

    sendMessage(db, "agent-b", "evolve-ch", "no mention here");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(200);
    await stop();

    // Group channel — no mention means no push, regardless of member count
    expect(notifications.length).toBe(0);
  });

  it("pushes when ANY message in batch mentions the agent (not just latest)", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    registerAgent(db, "agent-c");
    createChannel(db, "group-ch", "agent-b");
    sendMessage(db, "agent-b", "group-ch", "setup");
    subscribe(db, "agent-a", "group-ch");
    readMessages(db, "agent-a", "group-ch");
    subscribe(db, "agent-c", "group-ch");
    readMessages(db, "agent-c", "group-ch");  // 3rd member, group mode

    // Batch: first mentions agent-a, second and third do not
    sendMessage(db, "agent-b", "group-ch", "@agent-a review needed");
    sendMessage(db, "agent-b", "group-ch", "some context here");
    sendMessage(db, "agent-b", "group-ch", "more context");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(200);
    await stop();

    // Should notify because one of the messages in the batch mentions agent-a
    expect(notifications.length).toBe(1);
    expect(notifications[0]!.content).toContain("3 new messages");
  });

  it("does not push duplicate when cursor advances during in-flight notify", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "ch-a", "agent-b");
    sendMessage(db, "agent-b", "ch-a", "setup-a");
    subscribe(db, "agent-a", "ch-a");
    readMessages(db, "agent-a", "ch-a");
    createChannel(db, "ch-b", "agent-b");
    sendMessage(db, "agent-b", "ch-b", "setup-b");
    subscribe(db, "agent-a", "ch-b");
    readMessages(db, "agent-a", "ch-b");

    // Unread messages on both channels
    sendMessage(db, "agent-b", "ch-a", "unread-a");
    sendMessage(db, "agent-b", "ch-b", "unread-b");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
      if (meta.channel_name === "ch-a") {
        // Simulate: agent reads ch-b while ch-a notify is in-flight
        readMessages(db, "agent-a", "ch-b");
        await sleep(50);
      }
    }, FAST_INTERVAL);
    await sleep(400);
    await stop();

    // ch-b was already read during ch-a's notify, so it should NOT be pushed
    const chBNotifs = notifications.filter((n) => n.meta.channel_name === "ch-b");
    expect(chBNotifs.length).toBe(0);
  });

  it("channel creator receives notifications after subscribing", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");

    // agent-a creates the channel then subscribes (two-step, as per new semantics)
    createChannel(db, "my-channel", "agent-a");
    subscribe(db, "agent-a", "my-channel");

    // agent-b sends a message mentioning agent-a
    sendMessage(db, "agent-b", "my-channel", "@agent-a hey!");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(1);
    expect(notifications[0]!.content).toBe("@agent-a hey!");
  });

  it("DM access control rejects 3rd party subscribe", () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    registerAgent(db, "agent-c");
    createChannel(db, "agent-a,agent-b", "agent-b");
    sendMessage(db, "agent-b", "agent-a,agent-b", "setup");

    // 3rd agent cannot subscribe to a DM channel
    expect(() => subscribe(db, "agent-c", "agent-a,agent-b")).toThrow(
      'DM channel "agent-a,agent-b" is private to agent-a and agent-b'
    );
  });

  it("group channel requires mention regardless of member liveness", async () => {
    // 3 agents on a non-DM named channel
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    registerAgent(db, "agent-c");
    createChannel(db, "group-ch2", "agent-b");
    sendMessage(db, "agent-b", "group-ch2", "setup");
    subscribe(db, "agent-a", "group-ch2");
    readMessages(db, "agent-a", "group-ch2");
    subscribe(db, "agent-c", "group-ch2");
    readMessages(db, "agent-c", "group-ch2");

    // Simulate agent-c crashed: PID still set but last_seen_at is stale.
    const staleTime = Date.now() - 20 * 60 * 1000; // 20 minutes ago (> 15 min window)
    db.run("UPDATE agents SET last_seen_at = ? WHERE id = ?", [staleTime, "agent-c"]);

    // Send unmentioned message
    sendMessage(db, "agent-b", "group-ch2", "no mention here");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(200);
    await stop();

    // group-ch2 is not DM format → group channel regardless of active member count → no push without mention
    expect(notifications.length).toBe(0);
  });

  it("reclaims dead PID in heartbeat and continues polling", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "test-ch", "agent-b");
    sendMessage(db, "agent-b", "test-ch", "setup");
    subscribe(db, "agent-a", "test-ch");
    readMessages(db, "agent-a", "test-ch");

    // Simulate crash: dead foreign PID on agent-a
    db.run("UPDATE agents SET pid = 999999 WHERE id = ?", ["agent-a"]);

    // New message arrives after crash
    sendMessage(db, "agent-b", "test-ch", "@agent-a hello after crash");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(200);
    await stop();

    // Polling should have reclaimed the dead PID and delivered notification
    expect(notifications.length).toBe(1);
    expect(notifications[0]!.content).toBe("@agent-a hello after crash");

    // Agent should now have current PID
    const agent = db.query("SELECT pid FROM agents WHERE id = ?")
      .get("agent-a") as { pid: number };
    expect(agent.pid).toBe(process.pid);
  });

  it("stops polling when alive foreign PID owns the agent", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "test-ch", "agent-b");
    sendMessage(db, "agent-b", "test-ch", "setup");
    subscribe(db, "agent-a", "test-ch");
    readMessages(db, "agent-a", "test-ch");

    // PID 1 (init/launchd) is always alive — simulates real takeover
    db.run("UPDATE agents SET pid = 1 WHERE id = ?", ["agent-a"]);

    sendMessage(db, "agent-b", "test-ch", "should not arrive");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(200);
    await stop();

    // Polling should have stopped — no notifications
    expect(notifications.length).toBe(0);

    // PID should remain as 1 (not reclaimed)
    const agent = db.query("SELECT pid FROM agents WHERE id = ?")
      .get("agent-a") as { pid: number };
    expect(agent.pid).toBe(1);
  });
});
