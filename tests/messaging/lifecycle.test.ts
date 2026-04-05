import { describe, it, expect, afterEach } from "bun:test";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";
import { allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { MessagingService } from "../../src/core/messaging/service";
import { isAgentActive } from "../../src/core/utils";
import type { Agent } from "../../src/core/messaging/types";
import { createClaudeNotifier } from "../../src/notifications/claude-notifier/notifier";
import type { NotificationPort } from "../../src/core/ports";

const sleep = Bun.sleep;

const FAST_INTERVAL = 50;

const TEST_DB = testDbPath("lifecycle");

function setup() {
  const db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid);
  return { db, svc };
}

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("isAgentActive", () => {
  it("returns true when PID is set, alive, and last_seen_at is fresh", () => {
    const { db, svc } = setup();
    const agent = svc.register("active-agent");
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
    const { db, svc } = setup();
    svc.register("planner");

    svc.unregister("planner");

    const agent = db.query("SELECT * FROM agents WHERE id = ?").get("planner") as Agent;
    expect(agent).not.toBeNull();
    expect(agent.pid).toBeNull();
    expect(agent.registered_at).toBeNull();
    db.close();
  });

  it("is a no-op when expectedPid does not match (late onclose race)", () => {
    const { db, svc } = setup();
    svc.register("planner");

    // Simulate: session B has reclaimed with a different PID
    db.run("UPDATE agents SET pid = 12345 WHERE id = ?", ["planner"]);

    // Session A's late onclose fires with old PID
    svc.unregister("planner");

    // Should be no-op — PID 12345 still set
    const agent = db.query("SELECT * FROM agents WHERE id = ?").get("planner") as Agent;
    expect(agent.pid).toBe(12345);
    db.close();
  });

  it("preserves cursors — subscriptions and unread backlog survive", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "planning");
    svc.send("agent-b", "planning", "hello");

    // agent-a subscribes and reads, creating a cursor
    svc.subscribe("agent-a", "planning");
    svc.read("agent-a", "planning");

    // Unregister agent-a
    svc.unregister("agent-a");

    // Cursor should still exist
    const cursor = db
      .query("SELECT * FROM cursors WHERE agent_id = ?")
      .get("agent-a");
    expect(cursor).not.toBeNull();
    db.close();
  });

  it("allows immediate name reclaim after unregister", () => {
    const { db, svc } = setup();
    svc.register("planner");
    svc.unregister("planner");

    // Should succeed immediately — no staleness wait
    const reclaimed = svc.register("planner");
    expect(reclaimed.pid).toBe(process.pid);
    db.close();
  });

  it("preserves message attribution after unregister", () => {
    const { db, svc } = setup();
    svc.register("planner");
    svc.register("observer");
    svc.createChannel("planner", "work");
    svc.send("planner", "work", "important finding");

    svc.unregister("planner");

    // Messages still reference planner — observer needs cursor to read
    svc.subscribe("observer", "work");
    const msgs = svc.read("observer", "work", {
      before_id: Number.MAX_SAFE_INTEGER,
      limit: 10,
    });
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.agent_id).toBe("planner");
    db.close();
  });

  it("no-op for nonexistent agent", () => {
    const { db, svc } = setup();
    // Should not throw
    expect(() => svc.unregister("ghost")).not.toThrow();
    db.close();
  });
});

describe("listChannelMembers", () => {
  it("returns all cursor holders with correct active flag", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-a", "planning");
    svc.send("agent-a", "planning", "hello");
    svc.send("agent-b", "planning", "hi");

    const members = svc.listMembers("planning");
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
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-a", "planning");
    svc.send("agent-a", "planning", "hello");
    svc.send("agent-b", "planning", "hi");

    svc.unregister("agent-a");

    const members = svc.listMembers("planning");
    const a = members.find((m) => m.agent_id === "agent-a");
    expect(a!.active).toBe(false);
    db.close();
  });

  it("returns empty list for nonexistent channel", () => {
    const { db, svc } = setup();
    const members = svc.listMembers("nonexistent");
    expect(members).toEqual([]);
    db.close();
  });

  it("registered agent that unregisters shows as active: false in channel members", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.register("jay");
    svc.createChannel("agent-a", "planning");
    svc.send("agent-a", "planning", "setup");
    svc.send("agent-b", "planning", "ack");
    svc.send("jay", "planning", "from jay");

    // Jay unregisters (clears PID)
    svc.unregister("jay");

    const members = svc.listMembers("planning");
    const jayMember = members.find((m) => m.agent_id === "jay");
    expect(jayMember).toBeDefined();
    expect(jayMember!.active).toBe(false);
    db.close();
  });

  it("includes members created by subscribe (not just sendMessage)", () => {
    const { db, svc } = setup();
    svc.register("sender");
    svc.register("reader");
    svc.createChannel("sender", "ch");
    svc.send("sender", "ch", "hello");
    // reader joins via subscribe (creates cursor), never sends
    svc.subscribe("reader", "ch");

    const members = svc.listMembers("ch");
    expect(members.find((m) => m.agent_id === "reader")).toBeDefined();
    db.close();
  });

  it("includes members created by subscribe", () => {
    const { db, svc } = setup();
    svc.register("subscriber");
    svc.createChannel("subscriber", "ch");
    svc.subscribe("subscriber", "ch");

    const members = svc.listMembers("ch");
    expect(members.find((m) => m.agent_id === "subscriber")).toBeDefined();
    db.close();
  });

  it("history-mode reads (before_id) require membership (throws without cursor)", () => {
    const { db, svc } = setup();
    svc.register("sender");
    svc.register("browser");
    svc.createChannel("sender", "ch");
    svc.send("sender", "ch", "msg1");
    svc.send("sender", "ch", "msg2");

    // Read in history mode (before_id) without a cursor — throws "Not a member"
    expect(() => svc.read("browser", "ch", { before_id: 999, limit: 10 })).toThrow("Not a member");

    // browser should NOT have been added as a member
    const members = svc.listMembers("ch");
    expect(members.find((m) => m.agent_id === "browser")).toBeUndefined();
    db.close();
  });
});

describe("onclose cleanup behavior", () => {
  it("unregisterAgent clears PID and preserves existing cursors", () => {
    const { db, svc } = setup();
    svc.register("session-agent");
    svc.register("other");
    // Create cursor BEFORE unregister by subscribing to a channel
    svc.createChannel("other", "ch");
    svc.send("other", "ch", "setup");
    svc.subscribe("session-agent", "ch");
    svc.read("session-agent", "ch");

    // Simulate what mcp.ts onclose does
    svc.unregister("session-agent");

    const after = db.query("SELECT * FROM agents WHERE id = ?").get("session-agent") as Agent;
    expect(after.pid).toBeNull();
    expect(after.registered_at).toBeNull();
    expect(isAgentActive(after)).toBe(false);

    // Cursor created before unregister should still exist
    const cursor = db.query("SELECT * FROM cursors WHERE agent_id = ?").get("session-agent");
    expect(cursor).not.toBeNull();
    db.close();
  });

  it("onclose with null boundAgentId is safe (no-op)", () => {
    const { db, svc } = setup();
    // Simulate: session closes before registration — boundAgentId is null
    // The guard `if (boundAgentId)` in mcp.ts prevents the call entirely,
    // but verify unregister is safe with a nonexistent agent too
    expect(() => svc.unregister("never-registered")).not.toThrow();
    db.close();
  });
});

describe("listAgents with include_stale", () => {
  it("default (no arg) returns only active agents", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    // Seed a stale agent directly (simulates a row with no PID)
    const now = Date.now();
    db.run("INSERT INTO agents (id, created_at, last_seen_at) VALUES (?, ?, ?)", ["human", now, now]);

    const active = svc.listAgents();
    expect(active.length).toBe(1);
    expect(active[0]!.id).toBe("agent-a");
    db.close();
  });

  it("include_stale=true returns all agents including stale", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    // Seed a no-PID row directly
    const now = Date.now();
    db.run("INSERT INTO agents (id, created_at, last_seen_at) VALUES (?, ?, ?)", ["human", now, now]);

    svc.unregister("agent-b"); // PID nulled

    const all = svc.listAgents(true);
    expect(all.length).toBe(3); // agent-a, agent-b (nulled PID), human (no PID)
    db.close();
  });

  it("include_stale=false (explicit) excludes stale agents", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    // Seed a no-PID row directly
    const now = Date.now();
    db.run("INSERT INTO agents (id, created_at, last_seen_at) VALUES (?, ?, ?)", ["human", now, now]);

    svc.unregister("agent-b"); // PID nulled

    const active = svc.listAgents(false);
    expect(active.length).toBe(1);
    expect(active[0]!.id).toBe("agent-a");
    db.close();
  });
});

describe("reconnect behavior", () => {
  it("unread backlog is preserved across disconnect/reconnect", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-a", "work");
    svc.send("agent-a", "work", "setup");
    svc.subscribe("agent-b", "work");
    svc.read("agent-b", "work"); // agent-b has cursor

    // agent-b disconnects
    svc.unregister("agent-b");

    // Messages sent while offline
    svc.send("agent-a", "work", "while you were away 1");
    svc.send("agent-a", "work", "while you were away 2");

    // agent-b reconnects
    svc.register("agent-b");

    // Should see the 2 messages sent while offline
    const msgs = svc.read("agent-b", "work");
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.content).toBe("while you were away 1");
    expect(msgs[1]!.content).toBe("while you were away 2");
    db.close();
  });
});

describe("late onclose race", () => {
  it("late onclose does not clobber new session's registration", () => {
    const { db, svc } = setup();
    // Session A registers
    svc.register("planner");

    // Session B reclaims (simulate different PID)
    db.run("UPDATE agents SET pid = 12345, registered_at = ?, last_seen_at = ? WHERE id = ?", [Date.now(), Date.now(), "planner"]);

    // Session A's late onclose fires
    svc.unregister("planner");

    // Session B should be unaffected
    const agent = db.query("SELECT * FROM agents WHERE id = ?").get("planner") as Agent;
    expect(agent.pid).toBe(12345);
    expect(agent.registered_at).not.toBeNull();
    db.close();
  });
});

describe("reconnect polling", () => {
  it("notifications resume on previously subscribed channels after re-register", async () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-a", "agent-a,agent-b");
    svc.send("agent-a", "agent-a,agent-b", "setup");
    svc.subscribe("agent-b", "agent-a,agent-b");
    svc.read("agent-b", "agent-a,agent-b"); // agent-b subscribes

    // agent-b disconnects
    svc.unregister("agent-b");

    // agent-b reconnects
    svc.register("agent-b");

    // agent-a sends while agent-b is back
    svc.send("agent-a", "agent-a,agent-b", "welcome back");

    // agent-b starts polling — should get notification on existing subscription
    const notifications: { content: string; meta: Record<string, string> }[] = [];
    const repos = createSqliteRepos(db);
    const port: NotificationPort = {
      notify: async (content, meta) => { notifications.push({ content, meta }); },
    };
    const stop = createClaudeNotifier(svc, repos.agents, port, "agent-b", FAST_INTERVAL);
    await sleep(200);
    await stop();

    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications.some((n) => n.content.includes("welcome back"))).toBe(true);
    db.close();
  });
});

describe("ownership loss stops polling", () => {
  it("poller stops delivering notifications after another process reclaims the agent name", async () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "ch");
    svc.send("agent-b", "ch", "setup");
    svc.subscribe("agent-a", "ch");
    svc.read("agent-a", "ch");

    const notifications: { content: string }[] = [];
    const repos2 = createSqliteRepos(db);
    const port2: NotificationPort = {
      notify: async (content) => { notifications.push({ content }); },
    };
    const stop = createClaudeNotifier(svc, repos2.agents, port2, "agent-a", FAST_INTERVAL);

    // Let poller run a tick
    await sleep(100);

    // Simulate another process reclaiming agent-a's name.
    // PID 1 (init/launchd) is always alive — represents a real live takeover.
    const now = Date.now();
    db.run("UPDATE agents SET pid = 1, registered_at = ?, last_seen_at = ? WHERE id = ?", [now, now, "agent-a"]);

    // Send a message after reclaim
    svc.send("agent-b", "ch", "post-reclaim message");

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
    const { db, svc } = setup();
    svc.register("planner");
    // Simulate crash: set PID to a dead process, last_seen_at is fresh
    db.run("UPDATE agents SET pid = 999999 WHERE id = ?", ["planner"]);

    // Should reclaim immediately — isProcessAlive(999999) returns false
    const reclaimed = svc.register("planner");
    expect(reclaimed.pid).toBe(process.pid);
    db.close();
  });
});
