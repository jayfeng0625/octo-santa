import { describe, it, expect, afterEach } from "bun:test";
import { SqliteAgentRepo } from "../../../src/storage/sqlite/agent-repo";
import { createDb } from "../../../src/storage/sqlite/db";
import { runMigrations, allMigrations } from "../../../src/storage/sqlite/migrations";
import { cleanupDb } from "../../helpers/db";

const TEST_DB = `/tmp/octo-santa-test-hex-agent-repo-${process.pid}.sqlite`;

function setup() {
  cleanupDb(TEST_DB);
  const db = createDb(TEST_DB);
  runMigrations(db, allMigrations);
  return { db, repo: new SqliteAgentRepo(db) };
}

afterEach(() => cleanupDb(TEST_DB));

describe("SqliteAgentRepo", () => {
  it("register creates a new agent with pid", () => {
    const { db, repo } = setup();
    const agent = repo.register("test-agent", process.pid);
    expect(agent.id).toBe("test-agent");
    expect(agent.pid).toBe(process.pid);
    expect(agent.created_at).toBeGreaterThan(0);
    db.close();
  });

  it("register is idempotent for same pid", () => {
    const { db, repo } = setup();
    repo.register("test-agent", process.pid);
    expect(() => repo.register("test-agent", process.pid)).not.toThrow();
    db.close();
  });

  it("register rejects when existing agent has alive different pid", () => {
    const { db, repo } = setup();
    repo.register("test-agent", process.pid);
    db.run("UPDATE agents SET pid = 1 WHERE id = ?", ["test-agent"]);
    expect(() => repo.register("test-agent", process.pid)).toThrow("already active");
    db.close();
  });

  it("register reclaims dead pid", () => {
    const { db, repo } = setup();
    repo.register("test-agent", process.pid);
    db.run("UPDATE agents SET pid = 999999 WHERE id = ?", ["test-agent"]);
    const reclaimed = repo.register("test-agent", process.pid);
    expect(reclaimed.pid).toBe(process.pid);
    db.close();
  });

  it("register with profileFields stores base_name, persona, objective", () => {
    const { db, repo } = setup();
    const agent = repo.register("researcher-1", process.pid, {
      baseName: "researcher",
      persona: "You are a diligent researcher.",
      objective: "Gather and summarize information.",
    });
    expect(agent.id).toBe("researcher-1");
    expect(agent.base_name).toBe("researcher");
    expect(agent.persona).toBe("You are a diligent researcher.");
    expect(agent.objective).toBe("Gather and summarize information.");
    db.close();
  });

  it("register without profileFields stores null for base_name, persona, objective", () => {
    const { db, repo } = setup();
    const agent = repo.register("plain-agent", process.pid);
    expect(agent.base_name).toBeNull();
    expect(agent.persona).toBeNull();
    expect(agent.objective).toBeNull();
    db.close();
  });

  it("register clears stale profile when called without profileFields", () => {
    const { db, repo } = setup();
    // First register with profile
    repo.register("agent-x", process.pid, {
      baseName: "agent-x",
      persona: "Old persona",
      objective: "Old objective",
    });
    // Re-register without profile — should clear profile fields
    db.run("UPDATE agents SET pid = 999999 WHERE id = ?", ["agent-x"]);
    const updated = repo.register("agent-x", process.pid);
    expect(updated.base_name).toBeNull();
    expect(updated.persona).toBeNull();
    expect(updated.objective).toBeNull();
    db.close();
  });

  it("findById returns agent or null", () => {
    const { db, repo } = setup();
    expect(repo.findById("nonexistent")).toBeNull();
    repo.register("test-agent", process.pid);
    expect(repo.findById("test-agent")).not.toBeNull();
    db.close();
  });

  it("findByBaseName returns agents with matching base_name", () => {
    const { db, repo } = setup();
    const now = Date.now();
    // Insert worker-1 and worker-2 directly with base_name set
    db.run(
      `INSERT INTO agents (id, created_at, last_seen_at, pid, registered_at, base_name, persona, objective)
       VALUES ('worker-1', ${now}, ${now}, NULL, NULL, 'worker', NULL, NULL)`
    );
    db.run(
      `INSERT INTO agents (id, created_at, last_seen_at, pid, registered_at, base_name, persona, objective)
       VALUES ('worker-2', ${now}, ${now}, NULL, NULL, 'worker', NULL, NULL)`
    );
    repo.register("other-agent", process.pid);
    const workers = repo.findByBaseName("worker");
    expect(workers.length).toBe(2);
    expect(workers.map((a) => a.id).sort()).toEqual(["worker-1", "worker-2"]);
    db.close();
  });

  it("findByBaseName returns empty array when no matches", () => {
    const { db, repo } = setup();
    const result = repo.findByBaseName("nonexistent");
    expect(result).toEqual([]);
    db.close();
  });

  it("listAll returns all agents with profile fields", () => {
    const { db, repo } = setup();
    const now = Date.now();
    // Insert agent-b without profile fields directly
    db.run(
      `INSERT INTO agents (id, created_at, last_seen_at, pid, registered_at, base_name, persona, objective)
       VALUES ('agent-b', ${now}, ${now}, NULL, NULL, NULL, NULL, NULL)`
    );
    repo.register("agent-a", process.pid, {
      baseName: "agent-a",
      persona: "Persona A",
      objective: "Objective A",
    });
    const all = repo.listAll();
    expect(all.length).toBe(2);
    const a = all.find((x) => x.id === "agent-a")!;
    const b = all.find((x) => x.id === "agent-b")!;
    expect(a.base_name).toBe("agent-a");
    expect(a.persona).toBe("Persona A");
    expect(b.base_name).toBeNull();
    db.close();
  });

  it("clearPid sets pid to null when expectedPid matches", () => {
    const { db, repo } = setup();
    repo.register("test-agent", process.pid);
    repo.clearPid("test-agent", process.pid);
    const agent = repo.findById("test-agent");
    expect(agent!.pid).toBeNull();
    db.close();
  });

  it("heartbeatOrReclaim returns ok when pid matches", () => {
    const { db, repo } = setup();
    repo.register("test-agent", process.pid);
    expect(repo.heartbeatOrReclaim("test-agent", process.pid)).toBe("ok");
    db.close();
  });

  it("heartbeatOrReclaim returns lost when alive foreign pid owns agent", () => {
    const { db, repo } = setup();
    repo.register("test-agent", process.pid);
    db.run("UPDATE agents SET pid = 1 WHERE id = ?", ["test-agent"]);
    expect(repo.heartbeatOrReclaim("test-agent", process.pid)).toBe("lost");
    db.close();
  });
});

describe("SqliteAgentRepo - registerWithProfile", () => {
  it("singleton: registers with base name, instanceNumber null", () => {
    const { db, repo } = setup();
    const result = repo.registerWithProfile("researcher", process.pid, 1, {
      persona: "Researcher persona",
      objective: "Research things",
    });
    expect(result.registeredName).toBe("researcher");
    expect(result.instanceNumber).toBeNull();
    expect(result.agent.id).toBe("researcher");
    expect(result.agent.base_name).toBe("researcher");
    expect(result.agent.persona).toBe("Researcher persona");
    expect(result.agent.objective).toBe("Research things");
    db.close();
  });

  it("pool: first instance gets slot 1 (name: base-1)", () => {
    const { db, repo } = setup();
    const result = repo.registerWithProfile("worker", process.pid, 3, {
      persona: null,
      objective: null,
    });
    expect(result.registeredName).toBe("worker-1");
    expect(result.instanceNumber).toBe(1);
    expect(result.agent.id).toBe("worker-1");
    expect(result.agent.base_name).toBe("worker");
    db.close();
  });

  it("pool: new process reclaims dead slot (reclaim before new slot)", () => {
    const { db, repo } = setup();
    // Seed slot 1 as dead (stale pid + old last_seen_at)
    db.run(
      `INSERT INTO agents (id, created_at, last_seen_at, pid, registered_at, base_name, persona, objective)
       VALUES ('worker-1', 1, 1, 999991, 1, 'worker', NULL, NULL)`
    );
    const result = repo.registerWithProfile("worker", process.pid, 3, {
      persona: null,
      objective: null,
    });
    // Slot 1 is dead → reclaimed
    expect(result.registeredName).toBe("worker-1");
    expect(result.instanceNumber).toBe(1);
    expect(result.agent.base_name).toBe("worker");
    db.close();
  });

  it("pool: slots fill in ascending order", () => {
    const { db, repo } = setup();
    // Seed worker-1 as alive by using the current process PID
    // We cannot use process.pid twice for slot 1 and slot 2, so we seed slot 1 alive
    // using a fake but considered-alive PID (PID 1 = init, always alive)
    db.run(
      `INSERT INTO agents (id, created_at, last_seen_at, pid, registered_at, base_name, persona, objective)
       VALUES ('worker-1', 1, ${Date.now()}, 1, 1, 'worker', NULL, NULL)`
    );
    const result = repo.registerWithProfile("worker", process.pid, 3, {
      persona: null,
      objective: null,
    });
    expect(result.registeredName).toBe("worker-2");
    expect(result.instanceNumber).toBe(2);
    db.close();
  });

  it("pool: third slot after two live slots", () => {
    const { db, repo } = setup();
    const now = Date.now();
    // Seed two live slots using PID 1 (init, always alive)
    db.run(
      `INSERT INTO agents (id, created_at, last_seen_at, pid, registered_at, base_name, persona, objective)
       VALUES ('worker-1', 1, ${now}, 1, 1, 'worker', NULL, NULL)`
    );
    db.run(
      `INSERT INTO agents (id, created_at, last_seen_at, pid, registered_at, base_name, persona, objective)
       VALUES ('worker-2', 1, ${now}, 1, 1, 'worker', NULL, NULL)`
    );
    const result = repo.registerWithProfile("worker", process.pid, 5, {
      persona: null,
      objective: null,
    });
    expect(result.registeredName).toBe("worker-3");
    expect(result.instanceNumber).toBe(3);
    db.close();
  });

  it("idempotent: same PID re-registering returns existing slot", () => {
    const { db, repo } = setup();
    const first = repo.registerWithProfile("worker", process.pid, 3, {
      persona: null,
      objective: null,
    });
    const second = repo.registerWithProfile("worker", process.pid, 3, {
      persona: null,
      objective: null,
    });
    expect(second.registeredName).toBe(first.registeredName);
    expect(second.instanceNumber).toBe(first.instanceNumber);
    db.close();
  });

  it("reclaim: dead slot gets reassigned to new PID", () => {
    const { db, repo } = setup();
    const now = Date.now();
    // Seed two workers: slot 1 owned by current PID, slot 2 owned by PID 1 (init, always alive)
    repo.registerWithProfile("worker", process.pid, 3, { persona: null, objective: null });
    db.run(
      `INSERT INTO agents (id, created_at, last_seen_at, pid, registered_at, base_name, persona, objective)
       VALUES ('worker-2', 1, ${now}, 1, 1, 'worker', NULL, NULL)`
    );
    // Kill slot 1 by setting dead pid
    db.run("UPDATE agents SET pid = 999999, last_seen_at = 0 WHERE id = ?", ["worker-1"]);
    // New process should reclaim slot 1 (lowest dead slot)
    const result = repo.registerWithProfile("worker", process.pid + 100, 3, {
      persona: null,
      objective: null,
    });
    expect(result.registeredName).toBe("worker-1");
    expect(result.instanceNumber).toBe(1);
    expect(result.agent.pid).toBe(process.pid + 100);
    db.close();
  });

  it("capacity: throws when all slots are alive", () => {
    const { db, repo } = setup();
    const now = Date.now();
    // Seed two slots as alive using PID 1 (init, always alive)
    db.run(
      `INSERT INTO agents (id, created_at, last_seen_at, pid, registered_at, base_name, persona, objective)
       VALUES ('worker-1', 1, ${now}, 1, 1, 'worker', NULL, NULL)`
    );
    db.run(
      `INSERT INTO agents (id, created_at, last_seen_at, pid, registered_at, base_name, persona, objective)
       VALUES ('worker-2', 1, ${now}, 1, 1, 'worker', NULL, NULL)`
    );
    // Both slots are alive — a third process should fail
    expect(() =>
      repo.registerWithProfile("worker", process.pid, 2, { persona: null, objective: null })
    ).toThrow(/capacity/i);
    db.close();
  });

  it("singleton idempotent: same PID re-registering singleton returns same result", () => {
    const { db, repo } = setup();
    const first = repo.registerWithProfile("unique-bot", process.pid, 1, {
      persona: "Bot persona",
      objective: null,
    });
    const second = repo.registerWithProfile("unique-bot", process.pid, 1, {
      persona: "Bot persona",
      objective: null,
    });
    expect(second.registeredName).toBe("unique-bot");
    expect(second.instanceNumber).toBeNull();
    expect(second.agent.id).toBe(first.agent.id);
    db.close();
  });

  it("singleton collision: throws when a live agent with different PID owns the slot", () => {
    const { db, repo } = setup();
    const now = Date.now();
    // Seed singleton owned by PID 1 (init, always alive)
    db.run(
      `INSERT INTO agents (id, created_at, last_seen_at, pid, registered_at, base_name, persona, objective)
       VALUES ('unique-bot', 1, ${now}, 1, 1, 'unique-bot', 'Bot', NULL)`
    );
    expect(() =>
      repo.registerWithProfile("unique-bot", process.pid, 1, { persona: "Bot", objective: null })
    ).toThrow(/already active/i);
    db.close();
  });
});
