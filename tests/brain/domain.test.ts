import { describe, it, expect, afterEach } from "bun:test";
import { allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { MessagingService } from "../../src/core/messaging/service";
import { BrainService } from "../../src/core/brain/service";
import { FsBrainStore } from "../../src/storage/fs-brain-store/store";
import type { OctoSantaConfig } from "../../src/core/brain/types";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";

const TEST_DB = testDbPath("brain-domain");

function setup(config: OctoSantaConfig | null = null) {
  const db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  const msgSvc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid);
  const brainStore = new FsBrainStore("/tmp");
  const brainSvc = new BrainService(brainStore, repos.domains, repos.agents, config, process.pid);
  return { db, msgSvc, brainSvc, repos };
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

describe("upsertDomain (registerDomain)", () => {
  it("inserts domain row when config has domain", () => {
    const { db, brainSvc } = setup(CONFIG_WITH_DOMAIN);
    brainSvc.registerDomain("/some/cwd");

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
    const { db, brainSvc } = setup(CONFIG_WITH_DOMAIN);
    brainSvc.registerDomain("/original/cwd");
    brainSvc.registerDomain("/updated/cwd");

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
    const { db, brainSvc } = setup(CONFIG_NO_DOMAIN);
    brainSvc.registerDomain("/some/cwd");

    const count = db.query("SELECT COUNT(*) as count FROM domains").get() as { count: number };
    expect(count.count).toBe(0);

    db.close();
  });
});

describe("claimDomain", () => {
  it("inserts domain claim for a registered agent", () => {
    const { db, msgSvc, brainSvc } = setup(CONFIG_WITH_DOMAIN);

    // Must register domain first (foreign key constraint)
    brainSvc.registerDomain("/some/cwd");
    msgSvc.register("test-agent");
    brainSvc.claimDomain("test-agent");

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
    const { db, brainSvc } = setup(CONFIG_WITH_DOMAIN);
    brainSvc.registerDomain("/some/cwd");

    // Don't call register — no row exists for this agent+pid combination
    expect(() => brainSvc.claimDomain("unregistered-agent")).toThrow(
      "Must call messaging_register"
    );

    db.close();
  });

  it("throws when config has no domain", () => {
    const { db, msgSvc, brainSvc } = setup(CONFIG_NO_DOMAIN);
    msgSvc.register("test-agent");

    expect(() => brainSvc.claimDomain("test-agent")).toThrow(
      "No domain configured"
    );

    db.close();
  });

  it("throws when config is null", () => {
    const { db, msgSvc, brainSvc } = setup(null);
    msgSvc.register("test-agent");

    expect(() => brainSvc.claimDomain("test-agent")).toThrow("No domain configured");

    db.close();
  });
});

describe("findExperts", () => {
  it("returns domains with active_sessions for live agents", () => {
    const { db, msgSvc, brainSvc } = setup(CONFIG_WITH_DOMAIN);

    brainSvc.registerDomain("/some/cwd");
    msgSvc.register("expert-agent");
    brainSvc.claimDomain("expert-agent");

    const experts = brainSvc.findExperts();
    expect(experts).toHaveLength(1);
    expect(experts[0]!.identifier).toBe("my-project");
    expect(experts[0]!.tags).toEqual(["typescript", "api"]);
    expect(experts[0]!.description).toBe("My project domain");
    expect(experts[0]!.active_sessions).toContain("expert-agent");

    db.close();
  });

  it("filters dead PIDs from active_sessions", () => {
    const { db, msgSvc, brainSvc } = setup(CONFIG_WITH_DOMAIN);

    brainSvc.registerDomain("/some/cwd");
    msgSvc.register("dead-agent");
    brainSvc.claimDomain("dead-agent");

    // Simulate dead agent by setting pid to 999999 (almost certainly dead)
    db.run("UPDATE agents SET pid = 999999 WHERE id = ?", ["dead-agent"]);
    db.run("UPDATE domain_claims SET pid = 999999 WHERE agent_id = ?", ["dead-agent"]);

    const experts = brainSvc.findExperts();
    expect(experts).toHaveLength(1);
    expect(experts[0]!.active_sessions).not.toContain("dead-agent");
    expect(experts[0]!.active_sessions).toHaveLength(0);

    db.close();
  });

  it("returns multiple agents claiming the same domain in active_sessions", () => {
    const { db, msgSvc, brainSvc } = setup(CONFIG_WITH_DOMAIN);

    brainSvc.registerDomain("/some/cwd");
    msgSvc.register("agent-one");
    brainSvc.claimDomain("agent-one");

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

    const experts = brainSvc.findExperts();
    expect(experts).toHaveLength(1);
    expect(experts[0]!.active_sessions).toHaveLength(2);
    expect(experts[0]!.active_sessions).toContain("agent-one");
    expect(experts[0]!.active_sessions).toContain("agent-two");

    db.close();
  });

  it("returns domain with empty active_sessions when no claims exist", () => {
    const { db, brainSvc } = setup(CONFIG_WITH_DOMAIN);
    brainSvc.registerDomain("/some/cwd");

    const experts = brainSvc.findExperts();
    expect(experts).toHaveLength(1);
    expect(experts[0]!.active_sessions).toHaveLength(0);

    db.close();
  });

  it("returns empty array when no domains are registered", () => {
    const { db, brainSvc } = setup(CONFIG_WITH_DOMAIN);
    const experts = brainSvc.findExperts();
    expect(experts).toEqual([]);
    db.close();
  });
});

describe("onBrainDisconnect", () => {
  it("deletes the claim for the disconnecting agent", () => {
    const { db, msgSvc, brainSvc } = setup(CONFIG_WITH_DOMAIN);

    brainSvc.registerDomain("/some/cwd");
    msgSvc.register("test-agent");
    brainSvc.claimDomain("test-agent");

    // Verify claim exists before disconnect
    const beforeCount = db
      .query("SELECT COUNT(*) as count FROM domain_claims WHERE agent_id = ?")
      .get("test-agent") as { count: number };
    expect(beforeCount.count).toBe(1);

    brainSvc.onDisconnect("test-agent", process.pid);

    const afterCount = db
      .query("SELECT COUNT(*) as count FROM domain_claims WHERE agent_id = ?")
      .get("test-agent") as { count: number };
    expect(afterCount.count).toBe(0);

    db.close();
  });

  it("does not affect other agents' claims", () => {
    const { db, msgSvc, brainSvc } = setup(CONFIG_WITH_DOMAIN);

    brainSvc.registerDomain("/some/cwd");
    msgSvc.register("agent-to-disconnect");
    brainSvc.claimDomain("agent-to-disconnect");

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

    brainSvc.onDisconnect("agent-to-disconnect", process.pid);

    // other-agent's claim should still be present
    const otherCount = db
      .query("SELECT COUNT(*) as count FROM domain_claims WHERE agent_id = ?")
      .get("other-agent") as { count: number };
    expect(otherCount.count).toBe(1);

    db.close();
  });

  it("is a no-op when no claim exists for the agent", () => {
    const { db, brainSvc } = setup(CONFIG_WITH_DOMAIN);

    expect(() => brainSvc.onDisconnect("ghost-agent", process.pid)).not.toThrow();

    db.close();
  });
});
