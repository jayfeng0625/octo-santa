import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { createDb } from "../../src/db";
import { runMigrations } from "../../src/migrations";
import {
  messagingMigrations,
  registerAgent,
  unregisterAgent,
  getAgent,
  listAgents,
  listChannelMembers,
  subscribeToChannel,
  sendMessage,
  readMessages,
  isAgentActive,
} from "../../src/modules/messaging/tools";
import type { Agent } from "../../src/modules/messaging/types";
import { startPolling } from "../../src/channel";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const FAST_INTERVAL = 50;

const TEST_DB = `/tmp/octo-santa-test-lifecycle-${process.pid}.sqlite`;

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
    sendMessage(db, "agent-b", "planning", "hello");

    // agent-a reads, creating a cursor
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
    sendMessage(db, "planner", "work", "important finding");

    unregisterAgent(db, "planner", process.pid);

    // Messages still reference planner
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

  it("REPL-only senders appear with active: false", () => {
    const db = setupDb();
    // ensureAgent path (no PID) — simulates human REPL sender
    sendMessage(db, "jay", "planning", "human message");

    const members = listChannelMembers(db, "planning");
    const jay = members.find((m) => m.agent_id === "jay");
    expect(jay).toBeDefined();
    expect(jay!.active).toBe(false);
    db.close();
  });

  it("includes members created by readMessages (not just sendMessage)", () => {
    const db = setupDb();
    registerAgent(db, "sender");
    registerAgent(db, "reader");
    sendMessage(db, "sender", "ch", "hello");
    // reader joins via readMessages (creates cursor), never sends
    readMessages(db, "reader", "ch");

    const members = listChannelMembers(db, "ch");
    expect(members.find((m) => m.agent_id === "reader")).toBeDefined();
    db.close();
  });

  it("includes members created by subscribeToChannel", () => {
    const db = setupDb();
    registerAgent(db, "subscriber");
    subscribeToChannel(db, "subscriber", "ch");

    const members = listChannelMembers(db, "ch");
    expect(members.find((m) => m.agent_id === "subscriber")).toBeDefined();
    db.close();
  });

  it("history-mode reads (before_id) do NOT create membership", () => {
    const db = setupDb();
    registerAgent(db, "sender");
    registerAgent(db, "browser");
    sendMessage(db, "sender", "ch", "msg1");
    sendMessage(db, "sender", "ch", "msg2");

    // Read in history mode (before_id) — should not create a cursor
    readMessages(db, "browser", "ch", { before_id: 999, limit: 10 });

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
    sendMessage(db, "other", "ch", "setup");
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

describe("listAgents with active_only", () => {
  it("active_only false returns all agents (backward compatible)", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    // Create a lightweight agent via sendMessage (no PID)
    sendMessage(db, "human", "ch", "hi");

    const all = listAgents(db);
    expect(all.length).toBe(2);
    db.close();
  });

  it("active_only true excludes unregistered and no-PID agents", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    sendMessage(db, "human", "ch", "hi"); // no PID

    unregisterAgent(db, "agent-b", process.pid); // PID nulled

    const active = listAgents(db, true);
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
    sendMessage(db, "agent-a", "work", "setup");
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
    sendMessage(db, "agent-a", "dm-ch", "setup");
    readMessages(db, "agent-b", "dm-ch"); // agent-b subscribes

    // agent-b disconnects
    unregisterAgent(db, "agent-b", process.pid);

    // agent-b reconnects
    registerAgent(db, "agent-b");

    // agent-a sends while agent-b is back
    sendMessage(db, "agent-a", "dm-ch", "welcome back");

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
    sendMessage(db, "agent-b", "ch", "setup");
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

describe("ensureAgent ownership scoping", () => {
  it("implicit sendMessage does not refresh last_seen_at for foreign registered agent", () => {
    const db = setupDb();
    registerAgent(db, "planner");

    // Simulate crash: foreign PID, stale last_seen_at
    const staleTime = Date.now() - 20 * 60 * 1000;
    db.run("UPDATE agents SET pid = 1, last_seen_at = ? WHERE id = ?", [staleTime, "planner"]);

    // Another process sends as "planner" (REPL impersonation or name collision)
    sendMessage(db, "planner", "ch", "hello from impersonator");

    // last_seen_at should NOT have been refreshed
    const agent = getAgent(db, "planner")!;
    expect(agent.last_seen_at).toBe(staleTime);
    expect(isAgentActive(agent)).toBe(false);
    db.close();
  });

  it("stale-PID reclaim still works after implicit traffic on the name", () => {
    const db = setupDb();
    registerAgent(db, "planner");

    // Simulate crash
    const staleTime = Date.now() - 20 * 60 * 1000;
    db.run("UPDATE agents SET pid = 1, last_seen_at = ? WHERE id = ?", [staleTime, "planner"]);

    // Traffic on the name from a different process
    sendMessage(db, "planner", "ch", "this should not block reclaim");

    // Reclaim should succeed
    const reclaimed = registerAgent(db, "planner");
    expect(reclaimed.pid).toBe(process.pid);
    db.close();
  });

  it("ensureAgent still refreshes last_seen_at for own registered agent", () => {
    const db = setupDb();
    registerAgent(db, "mine");
    const before = getAgent(db, "mine")!.last_seen_at;

    sendMessage(db, "mine", "ch", "my own message");

    const after = getAgent(db, "mine")!;
    expect(after.last_seen_at).toBeGreaterThanOrEqual(before);
    db.close();
  });

  it("ensureAgent still refreshes last_seen_at for unregistered agent (no PID)", () => {
    const db = setupDb();
    // First call creates lightweight row
    sendMessage(db, "human", "ch", "first");
    const first = getAgent(db, "human")!;
    expect(first.pid).toBeNull();
    const firstTime = first.last_seen_at;

    // Second call should refresh
    sendMessage(db, "human", "ch", "second");
    const after = getAgent(db, "human")!;
    expect(after.last_seen_at).toBeGreaterThanOrEqual(firstTime);
    db.close();
  });

  it("ensureAgent reclaims dead PID and sets current process PID", () => {
    const db = setupDb();
    registerAgent(db, "crashed");

    // Simulate crash: set a dead foreign PID
    const staleTime = Date.now() - 20 * 60 * 1000;
    db.run("UPDATE agents SET pid = 999999, last_seen_at = ? WHERE id = ?", [staleTime, "crashed"]);

    // ensureAgent via sendMessage should reclaim the dead PID
    sendMessage(db, "crashed", "ch", "hello after restart");

    const agent = getAgent(db, "crashed")!;
    expect(agent.pid).toBe(process.pid);
    expect(agent.last_seen_at).toBeGreaterThan(staleTime);
    db.close();
  });

  it("ensureAgent does NOT reclaim alive foreign PID", () => {
    const db = setupDb();
    registerAgent(db, "owned");

    // PID 1 (init/launchd) is always alive
    db.run("UPDATE agents SET pid = 1 WHERE id = ?", ["owned"]);
    const before = getAgent(db, "owned")!;

    sendMessage(db, "owned", "ch", "should not reclaim");

    const after = getAgent(db, "owned")!;
    expect(after.pid).toBe(1); // unchanged — alive process still owns it
    db.close();
  });
});
