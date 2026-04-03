// tests/channel/channel.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { createDb } from "../../src/db";
import { runMigrations } from "../../src/migrations";
import {
  messagingMigrations,
  registerAgent,
  subscribeToChannel,
  sendMessage,
  readMessages,
  unregisterAgent,
  PID_STALE_MS,
} from "../../src/modules/messaging/tools";
import { startPolling, type NotifyFn } from "../../src/channel";
import type { Database } from "bun:sqlite";

let testDbPath: string;
let db: Database;

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = path + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const FAST_INTERVAL = 50;

beforeEach(() => {
  testDbPath = `/tmp/octo-santa-test-channel-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
  cleanupDb(testDbPath);
  db = createDb(testDbPath);
  runMigrations(db, messagingMigrations);
});

afterEach(() => {
  try { db.close(); } catch {}
  cleanupDb(testDbPath);
});

describe("startPolling", () => {
  it("finds unread messages and calls notify with correct format", async () => {
    sendMessage(db, "agent-b", "coordination", "hello from b");
    readMessages(db, "agent-a", "coordination");
    sendMessage(db, "agent-b", "coordination", "second msg");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const notify: NotifyFn = async (content, meta) => {
      notifications.push({ content, meta });
    };

    const stop = startPolling(db, "agent-a", notify, FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(1);
    expect(notifications[0]!.content).toBe("second msg");
    expect(notifications[0]!.meta.channel_name).toBe("coordination");
    expect(notifications[0]!.meta.sender).toBe("agent-b");
    expect(notifications[0]!.meta.message_id).toBeDefined();
  });

  it("skips messages sent by the subscribing agent (self-exclusion)", async () => {
    sendMessage(db, "agent-b", "coordination", "setup");
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
    sendMessage(db, "agent-b", "coordination", "hello");
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
    sendMessage(db, "agent-b", "coordination", "first");
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
    sendMessage(db, "agent-b", "coordination", "setup");
    readMessages(db, "agent-a", "coordination");
    sendMessage(db, "agent-b", "coordination", "hello");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(300);
    await stop();

    expect(notifications.length).toBe(1);
  });

  it("initializes lastPushedId from cursor position (no historical flood)", async () => {
    sendMessage(db, "agent-b", "coordination", "first");
    sendMessage(db, "agent-b", "coordination", "second");
    sendMessage(db, "agent-b", "coordination", "third");
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
    sendMessage(db, "agent-b", "coordination", "coord msg");
    readMessages(db, "agent-a", "coordination");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(100);

    sendMessage(db, "agent-b", "frontend", "old frontend msg");
    readMessages(db, "agent-a", "frontend");
    sendMessage(db, "agent-b", "frontend", "new frontend msg");

    await sleep(200);
    await stop();

    const frontendNotifs = notifications.filter((n) => n.meta.channel_name === "frontend");
    expect(frontendNotifs.length).toBe(1);
    expect(frontendNotifs[0]!.content).toBe("new frontend msg");
  });

  it("coalesces multiple unread messages on same channel into one notification", async () => {
    sendMessage(db, "agent-b", "coordination", "setup");
    readMessages(db, "agent-a", "coordination");
    sendMessage(db, "agent-b", "coordination", "first");
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
    sendMessage(db, "agent-b", "coordination", "setup");
    readMessages(db, "agent-a", "coordination");
    sendMessage(db, "agent-b", "coordination", "hello");

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
    sendMessage(db, "agent-b", "coordination", "setup");
    readMessages(db, "agent-a", "coordination");
    sendMessage(db, "agent-b", "coordination", "unread");

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
    sendMessage(db, "agent-b", "coordination", "setup");
    readMessages(db, "agent-a", "coordination");
    sendMessage(db, "agent-b", "coordination", "unread");

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
    sendMessage(db, "agent-b", "coordination", "setup");
    readMessages(db, "agent-a", "coordination");
    for (let i = 1; i <= 15; i++) {
      sendMessage(db, "agent-b", "coordination", `msg-${i}`);
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
    sendMessage(db, "agent-b", "coordination", "setup");
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
    sendMessage(db, "agent-b", "group-ch", "setup");
    readMessages(db, "agent-a", "group-ch");
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
    sendMessage(db, "agent-b", "group-ch", "setup");
    readMessages(db, "agent-a", "group-ch");
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
    sendMessage(db, "agent-b", "group-ch", "setup");
    readMessages(db, "agent-a", "group-ch");
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
    sendMessage(db, "agent-b", "group-ch", "setup");
    readMessages(db, "agent-a", "group-ch");
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
    sendMessage(db, "agent-b", "dm-ch", "setup");
    readMessages(db, "agent-a", "dm-ch");
    // Only 2 members: agent-a and agent-b

    sendMessage(db, "agent-b", "dm-ch", "hey, no mention here");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(1);
    expect(notifications[0]!.content).toBe("hey, no mention here");
  });

  it("transitions from DM to group mode when 3rd member joins", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    sendMessage(db, "agent-b", "evolve-ch", "setup");
    readMessages(db, "agent-a", "evolve-ch");
    // 2 members — DM mode

    sendMessage(db, "agent-b", "evolve-ch", "dm message");

    const notifs1: { content: string; meta: Record<string, string> }[] = [];
    const stop1 = startPolling(db, "agent-a", async (content, meta) => {
      notifs1.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(200);
    await stop1();
    expect(notifs1.length).toBe(1);

    // 3rd registered member joins
    registerAgent(db, "agent-c");
    readMessages(db, "agent-c", "evolve-ch");
    sendMessage(db, "agent-b", "evolve-ch", "group message no mention");

    const notifs2: { content: string; meta: Record<string, string> }[] = [];
    const stop2 = startPolling(db, "agent-a", async (content, meta) => {
      notifs2.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(200);
    await stop2();

    // Group mode — no mention means no push
    expect(notifs2.length).toBe(0);
  });

  it("pushes when ANY message in batch mentions the agent (not just latest)", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    registerAgent(db, "agent-c");
    sendMessage(db, "agent-b", "group-ch", "setup");
    readMessages(db, "agent-a", "group-ch");
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
    sendMessage(db, "agent-b", "ch-a", "setup-a");
    readMessages(db, "agent-a", "ch-a");
    sendMessage(db, "agent-b", "ch-b", "setup-b");
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

  it("auto-subscribes channel creator — creator receives notifications", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");

    // agent-a creates the channel via subscribeToChannel (same path as messaging_create_channel tool)
    subscribeToChannel(db, "agent-a", "my-channel");

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

  it("reverts from group to DM mode after unregister", async () => {
    // 3 agents = group mode
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    registerAgent(db, "agent-c");
    sendMessage(db, "agent-b", "group-ch", "setup");
    readMessages(db, "agent-a", "group-ch");
    readMessages(db, "agent-c", "group-ch");

    // Unregister agent-c — PID nulled, drops to 2 active members (DM mode)
    unregisterAgent(db, "agent-c", process.pid);

    // Send unmentioned message
    sendMessage(db, "agent-b", "group-ch", "no mention here");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(200);
    await stop();

    // DM mode (2 members) → unmentioned messages notify
    expect(notifications.length).toBeGreaterThan(0);
  });

  it("stale-PID agent ages out of group mode member count", async () => {
    // 3 agents = group mode
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    registerAgent(db, "agent-c");
    sendMessage(db, "agent-b", "group-ch2", "setup");
    readMessages(db, "agent-a", "group-ch2");
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

    // agent-c aged out → 2 active members → DM mode → unmentioned messages notify
    expect(notifications.length).toBeGreaterThan(0);
  });

  it("reclaims dead PID in heartbeat and continues polling", async () => {
    registerAgent(db, "agent-a");
    sendMessage(db, "agent-b", "test-ch", "setup");
    readMessages(db, "agent-a", "test-ch");

    // Simulate crash: dead foreign PID on agent-a
    db.run("UPDATE agents SET pid = 999999 WHERE id = ?", ["agent-a"]);

    // New message arrives after crash
    sendMessage(db, "agent-b", "test-ch", "hello after crash");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-a", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(200);
    await stop();

    // Polling should have reclaimed the dead PID and delivered notification
    expect(notifications.length).toBe(1);
    expect(notifications[0]!.content).toBe("hello after crash");

    // Agent should now have current PID
    const agent = db.query("SELECT pid FROM agents WHERE id = ?")
      .get("agent-a") as { pid: number };
    expect(agent.pid).toBe(process.pid);
  });

  it("stops polling when alive foreign PID owns the agent", async () => {
    registerAgent(db, "agent-a");
    sendMessage(db, "agent-b", "test-ch", "setup");
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
