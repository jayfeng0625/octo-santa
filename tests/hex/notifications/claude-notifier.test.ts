// tests/hex/notifications/claude-notifier.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createClaudeNotifier } from "../../../src/notifications/claude-notifier/notifier";
import { MessagingService } from "../../../src/core/messaging/service";
import { createSqliteRepos } from "../../../src/storage/sqlite";
import { createDb } from "../../../src/storage/sqlite/db";
import { runMigrations, allMigrations } from "../../../src/storage/sqlite/migrations";
import type { NotificationPort } from "../../../src/core/ports";
import { cleanupDb } from "../../helpers/db";
import type { Database } from "bun:sqlite";

const FAST_INTERVAL = 50;
const sleep = Bun.sleep;

let TEST_DB: string;
let db: Database;

function setup() {
  TEST_DB = `/tmp/octo-santa-test-hex-notifier-${process.pid}-${Date.now()}.sqlite`;
  cleanupDb(TEST_DB);
  db = createDb(TEST_DB);
  runMigrations(db, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid);
  return { db, repos, svc };
}

afterEach(() => {
  try { db.close(); } catch {}
  cleanupDb(TEST_DB);
});

describe("createClaudeNotifier", () => {

  // === Unread mentioned -> notify ===
  it("delivers notification for unread mentioned message", async () => {
    const { repos, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "coordination");
    svc.send("agent-b", "coordination", "hello from b");
    svc.subscribe("agent-a", "coordination");
    svc.read("agent-a", "coordination");
    svc.send("agent-b", "coordination", "@agent-a second msg");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const port: NotificationPort = {
      notify: async (content, meta) => {
        notifications.push({ content, meta });
      },
    };

    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-a", FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(1);
    expect(notifications[0]!.content).toBe("@agent-a second msg");
    expect(notifications[0]!.meta.channel_name).toBe("coordination");
    expect(notifications[0]!.meta.sender).toBe("agent-b");
    expect(notifications[0]!.meta.message_id).toBeDefined();
  });

  // === No unread = no notify ===
  it("does nothing when there are no unread messages", async () => {
    const { repos, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "coordination");
    svc.send("agent-b", "coordination", "hello");
    svc.subscribe("agent-a", "coordination");
    svc.read("agent-a", "coordination");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const port: NotificationPort = {
      notify: async (content, meta) => {
        notifications.push({ content, meta });
      },
    };

    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-a", FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(0);
  });

  // === Does NOT advance cursors ===
  it("does NOT advance cursors on push", async () => {
    const { repos, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "coordination");
    svc.send("agent-b", "coordination", "first");
    svc.subscribe("agent-a", "coordination");
    svc.read("agent-a", "coordination");
    svc.send("agent-b", "coordination", "@agent-a second");

    const channel = db.query("SELECT id FROM channels WHERE name = ?").get("coordination") as { id: number };
    const cursorBefore = db.query(
      "SELECT last_read_message_id FROM cursors WHERE agent_id = ? AND channel_id = ?"
    ).get("agent-a", channel.id) as { last_read_message_id: number };

    const port: NotificationPort = {
      notify: async () => {},
    };

    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-a", FAST_INTERVAL);
    await sleep(200);
    await stop();

    const cursorAfter = db.query(
      "SELECT last_read_message_id FROM cursors WHERE agent_id = ? AND channel_id = ?"
    ).get("agent-a", channel.id) as { last_read_message_id: number };

    expect(cursorAfter.last_read_message_id).toBe(cursorBefore.last_read_message_id);
  });

  // === No duplicate across cycles ===
  it("does not notify the same message twice across poll cycles", async () => {
    const { repos, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "coordination");
    svc.send("agent-b", "coordination", "setup");
    svc.subscribe("agent-a", "coordination");
    svc.read("agent-a", "coordination");
    svc.send("agent-b", "coordination", "@agent-a hello");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const port: NotificationPort = {
      notify: async (content, meta) => {
        notifications.push({ content, meta });
      },
    };

    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-a", FAST_INTERVAL);
    await sleep(300);
    await stop();

    expect(notifications.length).toBe(1);
  });

  // === DM auto-notify ===
  it("auto-notifies in DM mode (2 members, no mention needed)", async () => {
    const { repos, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "agent-a,agent-b");
    svc.send("agent-b", "agent-a,agent-b", "setup");
    svc.subscribe("agent-a", "agent-a,agent-b");
    svc.read("agent-a", "agent-a,agent-b");

    svc.send("agent-b", "agent-a,agent-b", "hey, no mention here");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const port: NotificationPort = {
      notify: async (content, meta) => {
        notifications.push({ content, meta });
      },
    };

    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-a", FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(1);
    expect(notifications[0]!.content).toBe("hey, no mention here");
  });

  // === Group mention filter: no mention -> no push ===
  it("does NOT push messages without mentions in group mode", async () => {
    const { repos, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.register("agent-c");
    svc.createChannel("agent-b", "group-ch");
    svc.send("agent-b", "group-ch", "setup");
    svc.subscribe("agent-a", "group-ch");
    svc.read("agent-a", "group-ch");
    svc.subscribe("agent-c", "group-ch");
    svc.read("agent-c", "group-ch");

    svc.send("agent-b", "group-ch", "just a message, no mentions");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const port: NotificationPort = {
      notify: async (content, meta) => {
        notifications.push({ content, meta });
      },
    };

    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-a", FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(0);
  });

  // === Group mention filter: @agent -> push ===
  it("pushes to mentioned agent in group mode", async () => {
    const { repos, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.register("agent-c");
    svc.createChannel("agent-b", "group-ch");
    svc.send("agent-b", "group-ch", "setup");
    svc.subscribe("agent-a", "group-ch");
    svc.read("agent-a", "group-ch");
    svc.subscribe("agent-c", "group-ch");
    svc.read("agent-c", "group-ch");

    svc.send("agent-b", "group-ch", "@agent-a check this");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const port: NotificationPort = {
      notify: async (content, meta) => {
        notifications.push({ content, meta });
      },
    };

    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-a", FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(1);
    expect(notifications[0]!.content).toBe("@agent-a check this");
  });

  // === Group mention filter: @all -> push ===
  it("pushes @all messages to all subscribers in group mode", async () => {
    const { repos, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.register("agent-c");
    svc.createChannel("agent-b", "group-ch");
    svc.send("agent-b", "group-ch", "setup");
    svc.subscribe("agent-a", "group-ch");
    svc.read("agent-a", "group-ch");
    svc.subscribe("agent-c", "group-ch");
    svc.read("agent-c", "group-ch");

    svc.send("agent-b", "group-ch", "@all deploying now");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const port: NotificationPort = {
      notify: async (content, meta) => {
        notifications.push({ content, meta });
      },
    };

    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-a", FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(1);
    expect(notifications[0]!.content).toBe("@all deploying now");
  });

  // === Group mention filter: unmentioned agent not pushed ===
  it("does NOT push to unmentioned agent in group mode", async () => {
    const { repos, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.register("agent-c");
    svc.createChannel("agent-b", "group-ch");
    svc.send("agent-b", "group-ch", "setup");
    svc.subscribe("agent-a", "group-ch");
    svc.read("agent-a", "group-ch");
    svc.subscribe("agent-c", "group-ch");
    svc.read("agent-c", "group-ch");

    svc.send("agent-b", "group-ch", "@agent-c only for you");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const port: NotificationPort = {
      notify: async (content, meta) => {
        notifications.push({ content, meta });
      },
    };

    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-a", FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(0);
  });

  // === Batch mention scan ===
  it("pushes when ANY message in batch mentions the agent (not just latest)", async () => {
    const { repos, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.register("agent-c");
    svc.createChannel("agent-b", "group-ch");
    svc.send("agent-b", "group-ch", "setup");
    svc.subscribe("agent-a", "group-ch");
    svc.read("agent-a", "group-ch");
    svc.subscribe("agent-c", "group-ch");
    svc.read("agent-c", "group-ch");

    // Batch: first mentions agent-a, second and third do not
    svc.send("agent-b", "group-ch", "@agent-a review needed");
    svc.send("agent-b", "group-ch", "some context here");
    svc.send("agent-b", "group-ch", "more context");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const port: NotificationPort = {
      notify: async (content, meta) => {
        notifications.push({ content, meta });
      },
    };

    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-a", FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(1);
    expect(notifications[0]!.content).toContain("3 new messages");
  });

  // === HWM from cursor init ===
  it("initializes HWM from cursor position (no historical flood)", async () => {
    const { repos, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "coordination");
    svc.send("agent-b", "coordination", "first");
    svc.send("agent-b", "coordination", "second");
    svc.send("agent-b", "coordination", "third");
    svc.subscribe("agent-a", "coordination");
    svc.read("agent-a", "coordination");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const port: NotificationPort = {
      notify: async (content, meta) => {
        notifications.push({ content, meta });
      },
    };

    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-a", FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(0);
  });

  // === Mid-session subscription ===
  it("picks up new cursor mid-session without flooding history", async () => {
    const { repos, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "coordination");
    svc.send("agent-b", "coordination", "coord msg");
    svc.subscribe("agent-a", "coordination");
    svc.read("agent-a", "coordination");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const port: NotificationPort = {
      notify: async (content, meta) => {
        notifications.push({ content, meta });
      },
    };

    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-a", FAST_INTERVAL);
    await sleep(100);

    // Subscribe to a new channel mid-session
    svc.createChannel("agent-b", "frontend");
    svc.send("agent-b", "frontend", "old frontend msg");
    svc.subscribe("agent-a", "frontend");
    svc.read("agent-a", "frontend");
    svc.send("agent-b", "frontend", "@agent-a new frontend msg");

    await sleep(200);
    await stop();

    const frontendNotifs = notifications.filter((n) => n.meta.channel_name === "frontend");
    expect(frontendNotifs.length).toBe(1);
    expect(frontendNotifs[0]!.content).toBe("@agent-a new frontend msg");
  });

  // === Coalesces multiple unread ===
  it("coalesces multiple unread messages on same channel into one notification", async () => {
    const { repos, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "coordination");
    svc.send("agent-b", "coordination", "setup");
    svc.subscribe("agent-a", "coordination");
    svc.read("agent-a", "coordination");
    svc.send("agent-b", "coordination", "@agent-a first");
    svc.send("agent-b", "coordination", "second");
    svc.send("agent-b", "coordination", "third");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const port: NotificationPort = {
      notify: async (content, meta) => {
        notifications.push({ content, meta });
      },
    };

    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-a", FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(1);
    expect(notifications[0]!.content).toContain("3 new messages");
    expect(notifications[0]!.content).toContain("third");
  });

  // === Coalesces 15+ messages ===
  it("coalesces more than 10 unread messages into a single notification", async () => {
    const { repos, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "coordination");
    svc.send("agent-b", "coordination", "setup");
    svc.subscribe("agent-a", "coordination");
    svc.read("agent-a", "coordination");
    for (let i = 1; i <= 15; i++) {
      svc.send("agent-b", "coordination", i === 1 ? `@agent-a msg-${i}` : `msg-${i}`);
    }

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const port: NotificationPort = {
      notify: async (content, meta) => {
        notifications.push({ content, meta });
      },
    };

    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-a", FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(1);
    expect(notifications[0]!.content).toContain("15 new messages");
    expect(notifications[0]!.content).toContain("...and 5 more");
  });

  // === Notify failure -> no HWM ===
  it("does not advance watermark when notify fails", async () => {
    const { repos, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "coordination");
    svc.send("agent-b", "coordination", "setup");
    svc.subscribe("agent-a", "coordination");
    svc.read("agent-a", "coordination");
    svc.send("agent-b", "coordination", "@agent-a hello");

    let callCount = 0;
    const port: NotificationPort = {
      notify: async () => {
        callCount++;
        if (callCount === 1) throw new Error("simulated failure");
      },
    };

    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-a", FAST_INTERVAL);
    await sleep(300);
    await stop();

    expect(callCount).toBe(2);
  });

  // === Tick serialization ===
  it("does not run concurrent ticks (serialization)", async () => {
    const { repos, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "coordination");
    svc.send("agent-b", "coordination", "setup");
    svc.subscribe("agent-a", "coordination");
    svc.read("agent-a", "coordination");
    svc.send("agent-b", "coordination", "@agent-a unread");

    let concurrentCount = 0;
    let maxConcurrent = 0;
    const port: NotificationPort = {
      notify: async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await sleep(80);
        concurrentCount--;
      },
    };

    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-a", 10);
    await sleep(500);
    await stop();

    expect(maxConcurrent).toBe(1);
  });

  // === Quiescent shutdown ===
  it("stop() waits for in-flight tick to complete (quiescent shutdown)", async () => {
    const { repos, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "coordination");
    svc.send("agent-b", "coordination", "setup");
    svc.subscribe("agent-a", "coordination");
    svc.read("agent-a", "coordination");
    svc.send("agent-b", "coordination", "@agent-a unread");

    let notifyStarted = false;
    let notifyFinished = false;
    const port: NotificationPort = {
      notify: async () => {
        notifyStarted = true;
        await sleep(150);
        notifyFinished = true;
      },
    };

    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-a", 1);
    await sleep(20); // Let first tick start
    await stop(); // Should wait for notify to finish

    expect(notifyStarted).toBe(true);
    expect(notifyFinished).toBe(true);
  });

  // === Heartbeat updates ===
  it("updates agent last_seen_at on each poll tick (heartbeat)", async () => {
    const { repos, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "coordination");
    svc.send("agent-b", "coordination", "setup");
    svc.subscribe("agent-a", "coordination");
    svc.read("agent-a", "coordination");

    const before = db.query("SELECT last_seen_at FROM agents WHERE id = ?")
      .get("agent-a") as { last_seen_at: number };

    const port: NotificationPort = {
      notify: async () => {},
    };

    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-a", FAST_INTERVAL);
    await sleep(200);
    await stop();

    const after = db.query("SELECT last_seen_at FROM agents WHERE id = ?")
      .get("agent-a") as { last_seen_at: number };

    expect(after.last_seen_at).toBeGreaterThanOrEqual(before.last_seen_at);
  });

  // === Dead PID reclaim ===
  it("reclaims dead PID in heartbeat and continues polling", async () => {
    const { repos, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "test-ch");
    svc.send("agent-b", "test-ch", "setup");
    svc.subscribe("agent-a", "test-ch");
    svc.read("agent-a", "test-ch");

    // Simulate crash: dead foreign PID on agent-a
    db.run("UPDATE agents SET pid = 999999 WHERE id = ?", ["agent-a"]);

    // New message arrives after crash
    svc.send("agent-b", "test-ch", "@agent-a hello after crash");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const port: NotificationPort = {
      notify: async (content, meta) => {
        notifications.push({ content, meta });
      },
    };

    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-a", FAST_INTERVAL);
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

  // === Alive foreign PID -> stop ===
  it("stops polling when alive foreign PID owns the agent", async () => {
    const { repos, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "test-ch");
    svc.send("agent-b", "test-ch", "setup");
    svc.subscribe("agent-a", "test-ch");
    svc.read("agent-a", "test-ch");

    // PID 1 (init/launchd) is always alive — simulates real takeover
    db.run("UPDATE agents SET pid = 1 WHERE id = ?", ["agent-a"]);

    svc.send("agent-b", "test-ch", "@agent-a should not arrive");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const port: NotificationPort = {
      notify: async (content, meta) => {
        notifications.push({ content, meta });
      },
    };

    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-a", FAST_INTERVAL);
    await sleep(200);
    await stop();

    // Polling should have stopped — no notifications
    expect(notifications.length).toBe(0);

    // PID should remain as 1 (not reclaimed)
    const agent = db.query("SELECT pid FROM agents WHERE id = ?")
      .get("agent-a") as { pid: number };
    expect(agent.pid).toBe(1);
  });

  // === Self-exclusion (from original channel.test.ts) ===
  it("skips messages sent by the subscribing agent (self-exclusion)", async () => {
    const { repos, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "coordination");
    svc.send("agent-b", "coordination", "setup");
    svc.subscribe("agent-a", "coordination");
    svc.read("agent-a", "coordination");
    svc.send("agent-a", "coordination", "my own message");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const port: NotificationPort = {
      notify: async (content, meta) => {
        notifications.push({ content, meta });
      },
    };

    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-a", FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(0);
  });

  // === Non-DM channel with 2 members behaves as group ===
  it("non-DM channel with 2 members behaves as group (requires mentions)", async () => {
    const { repos, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "evolve-ch");
    svc.send("agent-b", "evolve-ch", "setup");
    svc.subscribe("agent-a", "evolve-ch");
    svc.read("agent-a", "evolve-ch");

    svc.send("agent-b", "evolve-ch", "no mention here");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const port: NotificationPort = {
      notify: async (content, meta) => {
        notifications.push({ content, meta });
      },
    };

    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-a", FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(0);
  });

  // === No cursors = no notify ===
  it("does nothing when agent has no cursors", async () => {
    const { repos, svc } = setup();
    svc.register("agent-a");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const port: NotificationPort = {
      notify: async (content, meta) => {
        notifications.push({ content, meta });
      },
    };

    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-a", FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBe(0);
  });
});
