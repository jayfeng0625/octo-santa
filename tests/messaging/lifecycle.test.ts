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
