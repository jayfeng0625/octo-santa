import { describe, it, expect, afterEach } from "bun:test";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";
import {
  messagingMigrations,
  registerAgent,
  unregisterAgent,
  getAgent,
  listAgents,
  listChannelMembers,
  createChannel,
  subscribe,
  sendMessage,
  readMessages,
  isAgentActive,
} from "../../src/modules/messaging/tools";
import type { Agent } from "../../src/modules/messaging/types";
import { startPolling } from "../../src/channel";

const sleep = Bun.sleep;

const FAST_INTERVAL = 50;

const TEST_DB = testDbPath("lifecycle");

function setupDb() {
  return setupTestDb(TEST_DB, messagingMigrations);
}

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("isAgentActive", () => {
  it("returns true when PID is set, alive, and last_seen_at is fresh", () => {
    const db = setupDb();
    const agent = registerAgent(db, "active-agent");
    // agent was just registered — PID is process.pid, last_seen_at is now
    expect(isAgentActive(agent)).toBe(true);
    db.close();
  });

  it("returns false when PID is null", () => {
    const agent: Agent = {
      id: "ghost",
      created_at: Date.now(),
      last_seen_at: Date.now(),
      pid: null,
      registered_at: null,
    };
    expect(isAgentActive(agent)).toBe(false);
  });

  it("returns false when PID is set but process is dead", () => {
    const agent: Agent = {
      id: "dead-agent",
      created_at: Date.now(),
      last_seen_at: Date.now(),
      pid: 999999, // almost certainly dead
      registered_at: Date.now(),
    };
    expect(isAgentActive(agent)).toBe(false);
  });

  it("returns false when PID is alive but last_seen_at exceeds staleness window", () => {
    const agent: Agent = {
      id: "stale-agent",
      created_at: Date.now(),
      last_seen_at: Date.now() - 20 * 60 * 1000, // 20 minutes ago (> 15 min window)
      pid: process.pid, // alive
      registered_at: Date.now() - 20 * 60 * 1000,
    };
    expect(isAgentActive(agent)).toBe(false);
  });
});

describe("unregisterAgent", () => {
  it("nulls PID and registered_at when expectedPid matches", () => {
    const db = setupDb();
    registerAgent(db, "planner");

    unregisterAgent(db, "planner", process.pid);

    const agent = getAgent(db, "planner")!;
    expect(agent).not.toBeNull();
    expect(agent.pid).toBeNull();
    expect(agent.registered_at).toBeNull();
    db.close();
  });

  it("is a no-op when expectedPid does not match (late onclose race)", () => {
    const db = setupDb();
    registerAgent(db, "planner");

    // Simulate: session B has reclaimed with a different PID
    db.run("UPDATE agents SET pid = 12345 WHERE id = ?", ["planner"]);

    // Session A's late onclose fires with old PID
    unregisterAgent(db, "planner", process.pid);

    // Should be no-op — PID 12345 still set
    const agent = getAgent(db, "planner")!;
    expect(agent.pid).toBe(12345);
    db.close();
  });

  it("preserves cursors — subscriptions and unread backlog survive", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "planning", "agent-b");
    sendMessage(db, "agent-b", "planning", "hello");

    // agent-a subscribes and reads, creating a cursor
    subscribe(db, "agent-a", "planning");
    readMessages(db, "agent-a", "planning");

    // Unregister agent-a
    unregisterAgent(db, "agent-a", process.pid);

    // Cursor should still exist
    const cursor = db
      .query("SELECT * FROM cursors WHERE agent_id = ?")
      .get("agent-a");
    expect(cursor).not.toBeNull();
    db.close();
  });

  it("allows immediate name reclaim after unregister", () => {
    const db = setupDb();
    registerAgent(db, "planner");
    unregisterAgent(db, "planner", process.pid);

    // Should succeed immediately — no staleness wait
    const reclaimed = registerAgent(db, "planner");
    expect(reclaimed.pid).toBe(process.pid);
    db.close();
  });

  it("preserves message attribution after unregister", () => {
    const db = setupDb();
    registerAgent(db, "planner");
    registerAgent(db, "observer");
    createChannel(db, "work", "planner");
    sendMessage(db, "planner", "work", "important finding");

    unregisterAgent(db, "planner", process.pid);

    // Messages still reference planner — observer needs cursor to read
    subscribe(db, "observer", "work");
    const msgs = readMessages(db, "observer", "work", {
      before_id: Number.MAX_SAFE_INTEGER,
      limit: 10,
    });
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.agent_id).toBe("planner");
    db.close();
  });

  it("no-op for nonexistent agent", () => {
    const db = setupDb();
    // Should not throw
    expect(() => unregisterAgent(db, "ghost", 12345)).not.toThrow();
    db.close();
  });
});

describe("listChannelMembers", () => {
  it("returns all cursor holders with correct active flag", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "planning", "agent-a");
    sendMessage(db, "agent-a", "planning", "hello");
    sendMessage(db, "agent-b", "planning", "hi");

    const members = listChannelMembers(db, "planning");
    expect(members).toHaveLength(2);

    const a = members.find((m) => m.agent_id === "agent-a");
    const b = members.find((m) => m.agent_id === "agent-b");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Both registered from this process, so both active
    expect(a!.active).toBe(true);
    expect(b!.active).toBe(true);
    db.close();
  });

  it("unregistered agents show as active: false", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "planning", "agent-a");
    sendMessage(db, "agent-a", "planning", "hello");
    sendMessage(db, "agent-b", "planning", "hi");

    unregisterAgent(db, "agent-a", process.pid);

    const members = listChannelMembers(db, "planning");
    const a = members.find((m) => m.agent_id === "agent-a");
    expect(a!.active).toBe(false);
    db.close();
  });

  it("returns empty list for nonexistent channel", () => {
    const db = setupDb();
    const members = listChannelMembers(db, "nonexistent");
    expect(members).toEqual([]);
    db.close();
  });

  it("registered agent that unregisters shows as active: false in channel members", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    registerAgent(db, "jay");
    createChannel(db, "planning", "agent-a");
    sendMessage(db, "agent-a", "planning", "setup");
    sendMessage(db, "agent-b", "planning", "ack");
    sendMessage(db, "jay", "planning", "from jay");

    // Jay unregisters (clears PID)
    unregisterAgent(db, "jay", process.pid);

    const members = listChannelMembers(db, "planning");
    const jayMember = members.find((m) => m.agent_id === "jay");
    expect(jayMember).toBeDefined();
    expect(jayMember!.active).toBe(false);
    db.close();
  });

  it("includes members created by subscribe (not just sendMessage)", () => {
    const db = setupDb();
    registerAgent(db, "sender");
    registerAgent(db, "reader");
    createChannel(db, "ch", "sender");
    sendMessage(db, "sender", "ch", "hello");
    // reader joins via subscribe (creates cursor), never sends
    subscribe(db, "reader", "ch");

    const members = listChannelMembers(db, "ch");
    expect(members.find((m) => m.agent_id === "reader")).toBeDefined();
    db.close();
  });

  it("includes members created by subscribe", () => {
    const db = setupDb();
    registerAgent(db, "subscriber");
    createChannel(db, "ch", "subscriber");
    subscribe(db, "subscriber", "ch");

    const members = listChannelMembers(db, "ch");
    expect(members.find((m) => m.agent_id === "subscriber")).toBeDefined();
    db.close();
  });

  it("history-mode reads (before_id) require membership (throws without cursor)", () => {
    const db = setupDb();
    registerAgent(db, "sender");
    registerAgent(db, "browser");
    createChannel(db, "ch", "sender");
    sendMessage(db, "sender", "ch", "msg1");
    sendMessage(db, "sender", "ch", "msg2");

    // Read in history mode (before_id) without a cursor — throws "Not a member"
    expect(() => readMessages(db, "browser", "ch", { before_id: 999, limit: 10 })).toThrow("Not a member");

    // browser should NOT have been added as a member
    const members = listChannelMembers(db, "ch");
    expect(members.find((m) => m.agent_id === "browser")).toBeUndefined();
    db.close();
  });
});

describe("onclose cleanup behavior", () => {
  it("unregisterAgent clears PID and preserves existing cursors", () => {
    const db = setupDb();
    registerAgent(db, "session-agent");
    registerAgent(db, "other");
    // Create cursor BEFORE unregister by subscribing to a channel
    createChannel(db, "ch", "other");
    sendMessage(db, "other", "ch", "setup");
    subscribe(db, "session-agent", "ch");
    readMessages(db, "session-agent", "ch");

    // Simulate what mcp.ts onclose does:
    // if (boundAgentId) unregisterAgent(db, boundAgentId, process.pid);
    unregisterAgent(db, "session-agent", process.pid);

    const after = getAgent(db, "session-agent")!;
    expect(after.pid).toBeNull();
    expect(after.registered_at).toBeNull();
    expect(isAgentActive(after)).toBe(false);

    // Cursor created before unregister should still exist
    const cursor = db.query("SELECT * FROM cursors WHERE agent_id = ?").get("session-agent");
    expect(cursor).not.toBeNull();
    db.close();
  });

  it("onclose with null boundAgentId is safe (no-op)", () => {
    const db = setupDb();
    // Simulate: session closes before registration — boundAgentId is null
    // The guard `if (boundAgentId)` in mcp.ts prevents the call entirely,
    // but verify unregisterAgent is safe with a nonexistent agent too
    expect(() => unregisterAgent(db, "never-registered", process.pid)).not.toThrow();
    db.close();
  });
});

describe("listAgents with include_stale", () => {
  it("default (no arg) returns only active agents", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    // Seed a stale agent directly (simulates a row with no PID)
    const now = Date.now();
    db.run("INSERT INTO agents (id, created_at, last_seen_at) VALUES (?, ?, ?)", ["human", now, now]);

    const active = listAgents(db);
    expect(active.length).toBe(1);
    expect(active[0]!.id).toBe("agent-a");
    db.close();
  });

  it("include_stale=true returns all agents including stale", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    // Seed a no-PID row directly
    const now = Date.now();
    db.run("INSERT INTO agents (id, created_at, last_seen_at) VALUES (?, ?, ?)", ["human", now, now]);

    unregisterAgent(db, "agent-b", process.pid); // PID nulled

    const all = listAgents(db, true);
    expect(all.length).toBe(3); // agent-a, agent-b (nulled PID), human (no PID)
    db.close();
  });

  it("include_stale=false (explicit) excludes stale agents", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    // Seed a no-PID row directly
    const now = Date.now();
    db.run("INSERT INTO agents (id, created_at, last_seen_at) VALUES (?, ?, ?)", ["human", now, now]);

    unregisterAgent(db, "agent-b", process.pid); // PID nulled

    const active = listAgents(db, false);
    expect(active.length).toBe(1);
    expect(active[0]!.id).toBe("agent-a");
    db.close();
  });
});

describe("reconnect behavior", () => {
  it("unread backlog is preserved across disconnect/reconnect", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "work", "agent-a");
    sendMessage(db, "agent-a", "work", "setup");
    subscribe(db, "agent-b", "work");
    readMessages(db, "agent-b", "work"); // agent-b has cursor

    // agent-b disconnects
    unregisterAgent(db, "agent-b", process.pid);

    // Messages sent while offline
    sendMessage(db, "agent-a", "work", "while you were away 1");
    sendMessage(db, "agent-a", "work", "while you were away 2");

    // agent-b reconnects
    registerAgent(db, "agent-b");

    // Should see the 2 messages sent while offline
    const msgs = readMessages(db, "agent-b", "work");
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.content).toBe("while you were away 1");
    expect(msgs[1]!.content).toBe("while you were away 2");
    db.close();
  });
});

describe("late onclose race", () => {
  it("late onclose does not clobber new session's registration", () => {
    const db = setupDb();
    // Session A registers
    registerAgent(db, "planner");

    // Session B reclaims (simulate different PID)
    db.run("UPDATE agents SET pid = 12345, registered_at = ?, last_seen_at = ? WHERE id = ?", [Date.now(), Date.now(), "planner"]);

    // Session A's late onclose fires
    unregisterAgent(db, "planner", process.pid);

    // Session B should be unaffected
    const agent = getAgent(db, "planner")!;
    expect(agent.pid).toBe(12345);
    expect(agent.registered_at).not.toBeNull();
    db.close();
  });
});

describe("reconnect polling", () => {
  it("notifications resume on previously subscribed channels after re-register", async () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "agent-a,agent-b", "agent-a");
    sendMessage(db, "agent-a", "agent-a,agent-b", "setup");
    subscribe(db, "agent-b", "agent-a,agent-b");
    readMessages(db, "agent-b", "agent-a,agent-b"); // agent-b subscribes

    // agent-b disconnects
    unregisterAgent(db, "agent-b", process.pid);

    // agent-b reconnects
    registerAgent(db, "agent-b");

    // agent-a sends while agent-b is back
    sendMessage(db, "agent-a", "agent-a,agent-b", "welcome back");

    // agent-b starts polling — should get notification on existing subscription
    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const stop = startPolling(db, "agent-b", async (content, meta) => {
      notifications.push({ content, meta });
    }, FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications.some((n) => n.content.includes("welcome back"))).toBe(true);
    db.close();
  });
});

describe("ownership loss stops polling", () => {
  it("poller stops delivering notifications after another process reclaims the agent name", async () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    createChannel(db, "ch", "agent-b");
    sendMessage(db, "agent-b", "ch", "setup");
    subscribe(db, "agent-a", "ch");
    readMessages(db, "agent-a", "ch");

    const notifications: { content: string }[] = [];
    const stop = startPolling(db, "agent-a", async (content) => {
      notifications.push({ content });
    }, FAST_INTERVAL);

    // Let poller run a tick
    await sleep(100);

    // Simulate another process reclaiming agent-a's name.
    // PID 1 (init/launchd) is always alive — represents a real live takeover.
    const now = Date.now();
    db.run("UPDATE agents SET pid = 1, registered_at = ?, last_seen_at = ? WHERE id = ?", [now, now, "agent-a"]);

    // Send a message after reclaim
    sendMessage(db, "agent-b", "ch", "post-reclaim message");

    // Wait for poller to detect ownership loss
    await sleep(200);
    await stop();

    // The post-reclaim message should NOT have been delivered
    expect(notifications.every((n) => !n.content.includes("post-reclaim"))).toBe(true);
    db.close();
  });
});

describe("crash recovery", () => {
  it("dead PID allows immediate name reclaim (no staleness wait)", () => {
    const db = setupDb();
    registerAgent(db, "planner");
    // Simulate crash: set PID to a dead process, last_seen_at is fresh
    db.run("UPDATE agents SET pid = 999999 WHERE id = ?", ["planner"]);

    // Should reclaim immediately — isProcessAlive(999999) returns false
    const reclaimed = registerAgent(db, "planner");
    expect(reclaimed.pid).toBe(process.pid);
    db.close();
  });
});
