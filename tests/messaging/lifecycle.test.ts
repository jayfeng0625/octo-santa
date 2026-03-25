import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { createDb } from "../../src/db";
import { runMigrations } from "../../src/migrations";
import {
  messagingMigrations,
  registerAgent,
  unregisterAgent,
  getAgent,
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
