import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { createDb } from "../../src/db";
import { runMigrations } from "../../src/migrations";
import {
  upsertDomain,
  claimDomain,
  findExperts,
  onBrainDisconnect,
  brainMigrations,
} from "../../src/modules/brain/tools";
import { messagingMigrations, registerAgent } from "../../src/modules/messaging/tools";
import type { OctoSantaConfig } from "../../src/modules/brain/types";

const TEST_DB = `/tmp/octo-santa-test-brain-domain-${process.pid}.sqlite`;

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = path + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
}

function setupDb() {
  cleanupDb(TEST_DB);
  const db = createDb(TEST_DB);
  runMigrations(db, [...messagingMigrations, ...brainMigrations]);
  return db;
}

afterEach(() => {
  cleanupDb(TEST_DB);
});

const CONFIG_WITH_DOMAIN: OctoSantaConfig = {
  domain: {
    identifier: "my-project",
    tags: ["typescript", "api"],
    description: "My project domain",
  },
  brain: { dirs: ["./brain"] },
};

const CONFIG_NO_DOMAIN: OctoSantaConfig = {
  brain: { dirs: ["./brain"] },
};

describe("upsertDomain", () => {
  it("inserts domain row when config has domain", () => {
    const db = setupDb();
    upsertDomain(db, CONFIG_WITH_DOMAIN, "/some/cwd");

    const row = db.query("SELECT * FROM domains WHERE identifier = ?").get("my-project") as {
      identifier: string;
      cwd: string;
      tags: string;
      description: string;
    } | null;

    expect(row).not.toBeNull();
    expect(row!.identifier).toBe("my-project");
    expect(row!.cwd).toBe("/some/cwd");
    expect(JSON.parse(row!.tags)).toEqual(["typescript", "api"]);
    expect(row!.description).toBe("My project domain");

    db.close();
  });

  it("updates CWD on second call with same identifier", () => {
    const db = setupDb();
    upsertDomain(db, CONFIG_WITH_DOMAIN, "/original/cwd");
    upsertDomain(db, CONFIG_WITH_DOMAIN, "/updated/cwd");

    const row = db.query("SELECT cwd FROM domains WHERE identifier = ?").get("my-project") as {
      cwd: string;
    } | null;

    expect(row).not.toBeNull();
    expect(row!.cwd).toBe("/updated/cwd");

    // Only one row should exist
    const count = db
      .query("SELECT COUNT(*) as count FROM domains WHERE identifier = ?")
      .get("my-project") as { count: number };
    expect(count.count).toBe(1);

    db.close();
  });

  it("does not insert when config has no domain", () => {
    const db = setupDb();
    upsertDomain(db, CONFIG_NO_DOMAIN, "/some/cwd");

    const count = db.query("SELECT COUNT(*) as count FROM domains").get() as { count: number };
    expect(count.count).toBe(0);

    db.close();
  });
});

describe("claimDomain", () => {
  it("inserts domain claim for a registered agent", () => {
    const db = setupDb();

    // Must upsert domain first (foreign key constraint)
    upsertDomain(db, CONFIG_WITH_DOMAIN, "/some/cwd");
    registerAgent(db, "test-agent");
    claimDomain(db, "test-agent", "/some/cwd", CONFIG_WITH_DOMAIN);

    const claim = db
      .query("SELECT * FROM domain_claims WHERE agent_id = ?")
      .get("test-agent") as { agent_id: string; pid: number; domain_identifier: string } | null;

    expect(claim).not.toBeNull();
    expect(claim!.agent_id).toBe("test-agent");
    expect(claim!.pid).toBe(process.pid);
    expect(claim!.domain_identifier).toBe("my-project");

    db.close();
  });

  it("throws if agent has not registered (not in agents table with current PID)", () => {
    const db = setupDb();
    upsertDomain(db, CONFIG_WITH_DOMAIN, "/some/cwd");

    // Don't call registerAgent — no row exists for this agent+pid combination
    expect(() => claimDomain(db, "unregistered-agent", "/some/cwd", CONFIG_WITH_DOMAIN)).toThrow(
      "Must call messaging_register"
    );

    db.close();
  });

  it("throws when config has no domain", () => {
    const db = setupDb();
    registerAgent(db, "test-agent");

    expect(() => claimDomain(db, "test-agent", "/some/cwd", CONFIG_NO_DOMAIN)).toThrow(
      "No domain configured"
    );

    db.close();
  });

  it("throws when config is null", () => {
    const db = setupDb();
    registerAgent(db, "test-agent");

    expect(() => claimDomain(db, "test-agent", "/some/cwd", null)).toThrow("No domain configured");

    db.close();
  });
});

describe("findExperts", () => {
  it("returns domains with active_sessions for live agents", () => {
    const db = setupDb();

    upsertDomain(db, CONFIG_WITH_DOMAIN, "/some/cwd");
    registerAgent(db, "expert-agent");
    claimDomain(db, "expert-agent", "/some/cwd", CONFIG_WITH_DOMAIN);

    const experts = findExperts(db);
    expect(experts).toHaveLength(1);
    expect(experts[0]!.identifier).toBe("my-project");
    expect(experts[0]!.tags).toEqual(["typescript", "api"]);
    expect(experts[0]!.description).toBe("My project domain");
    expect(experts[0]!.active_sessions).toContain("expert-agent");

    db.close();
  });

  it("filters dead PIDs from active_sessions", () => {
    const db = setupDb();

    upsertDomain(db, CONFIG_WITH_DOMAIN, "/some/cwd");
    registerAgent(db, "dead-agent");
    claimDomain(db, "dead-agent", "/some/cwd", CONFIG_WITH_DOMAIN);

    // Simulate dead agent by setting pid to 999999 (almost certainly dead)
    db.run("UPDATE agents SET pid = 999999 WHERE id = ?", ["dead-agent"]);
    db.run("UPDATE domain_claims SET pid = 999999 WHERE agent_id = ?", ["dead-agent"]);

    const experts = findExperts(db);
    expect(experts).toHaveLength(1);
    expect(experts[0]!.active_sessions).not.toContain("dead-agent");
    expect(experts[0]!.active_sessions).toHaveLength(0);

    db.close();
  });

  it("returns multiple agents claiming the same domain in active_sessions", () => {
    const db = setupDb();

    upsertDomain(db, CONFIG_WITH_DOMAIN, "/some/cwd");
    registerAgent(db, "agent-one");
    claimDomain(db, "agent-one", "/some/cwd", CONFIG_WITH_DOMAIN);

    // Register second agent — simulated by inserting directly since we can only
    // register one agent per PID per name; insert with current PID manually
    const now = Date.now();
    db.run(
      `INSERT INTO agents (id, created_at, last_seen_at, pid, registered_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, last_seen_at = excluded.last_seen_at`,
      ["agent-two", now, now, process.pid, now]
    );
    db.run(
      `INSERT INTO domain_claims (agent_id, pid, domain_identifier, claimed_at) VALUES (?, ?, ?, ?)`,
      ["agent-two", process.pid, "my-project", now]
    );

    const experts = findExperts(db);
    expect(experts).toHaveLength(1);
    expect(experts[0]!.active_sessions).toHaveLength(2);
    expect(experts[0]!.active_sessions).toContain("agent-one");
    expect(experts[0]!.active_sessions).toContain("agent-two");

    db.close();
  });

  it("returns domain with empty active_sessions when no claims exist", () => {
    const db = setupDb();
    upsertDomain(db, CONFIG_WITH_DOMAIN, "/some/cwd");

    const experts = findExperts(db);
    expect(experts).toHaveLength(1);
    expect(experts[0]!.active_sessions).toHaveLength(0);

    db.close();
  });

  it("returns empty array when no domains are registered", () => {
    const db = setupDb();
    const experts = findExperts(db);
    expect(experts).toEqual([]);
    db.close();
  });
});

describe("onBrainDisconnect", () => {
  it("deletes the claim for the disconnecting agent", () => {
    const db = setupDb();

    upsertDomain(db, CONFIG_WITH_DOMAIN, "/some/cwd");
    registerAgent(db, "test-agent");
    claimDomain(db, "test-agent", "/some/cwd", CONFIG_WITH_DOMAIN);

    // Verify claim exists before disconnect
    const beforeCount = db
      .query("SELECT COUNT(*) as count FROM domain_claims WHERE agent_id = ?")
      .get("test-agent") as { count: number };
    expect(beforeCount.count).toBe(1);

    onBrainDisconnect(db, "test-agent", process.pid);

    const afterCount = db
      .query("SELECT COUNT(*) as count FROM domain_claims WHERE agent_id = ?")
      .get("test-agent") as { count: number };
    expect(afterCount.count).toBe(0);

    db.close();
  });

  it("does not affect other agents' claims", () => {
    const db = setupDb();

    upsertDomain(db, CONFIG_WITH_DOMAIN, "/some/cwd");
    registerAgent(db, "agent-to-disconnect");
    claimDomain(db, "agent-to-disconnect", "/some/cwd", CONFIG_WITH_DOMAIN);

    // Add another agent's claim directly
    const now = Date.now();
    db.run(
      `INSERT INTO agents (id, created_at, last_seen_at, pid, registered_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, last_seen_at = excluded.last_seen_at`,
      ["other-agent", now, now, process.pid, now]
    );
    // Use a different pid for the other claim so it doesn't conflict
    db.run(
      `INSERT INTO domain_claims (agent_id, pid, domain_identifier, claimed_at) VALUES (?, ?, ?, ?)`,
      ["other-agent", 99998, "my-project", now]
    );

    onBrainDisconnect(db, "agent-to-disconnect", process.pid);

    // other-agent's claim should still be present
    const otherCount = db
      .query("SELECT COUNT(*) as count FROM domain_claims WHERE agent_id = ?")
      .get("other-agent") as { count: number };
    expect(otherCount.count).toBe(1);

    db.close();
  });

  it("is a no-op when no claim exists for the agent", () => {
    const db = setupDb();

    expect(() => onBrainDisconnect(db, "ghost-agent", process.pid)).not.toThrow();

    db.close();
  });
});
