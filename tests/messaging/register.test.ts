import { describe, it, expect, afterEach } from "bun:test";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";
import { allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { MessagingService } from "../../src/core/messaging/service";
import type { Agent } from "../../src/core/messaging/types";

const TEST_DB = testDbPath("register");

function setup() {
  const db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(repos.agents, repos.channels, repos.messages, process.pid);
  return { db, svc };
}

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("registerAgent", () => {
  it("registers a new agent", () => {
    const { db, svc } = setup();
    const result = svc.register("octo-santa");

    expect(result.id).toBe("octo-santa");
    expect(result.created_at).toBeGreaterThan(0);
    expect(result.last_seen_at).toBe(result.created_at);

    db.close();
  });

  it("is idempotent — second register updates last_seen_at", () => {
    const { db, svc } = setup();
    const first = svc.register("octo-santa");

    // Small delay to ensure different timestamp
    const second = svc.register("octo-santa");
    expect(second.id).toBe("octo-santa");
    expect(second.last_seen_at).toBeGreaterThanOrEqual(first.last_seen_at);

    db.close();
  });

  it("can retrieve a registered agent", () => {
    const { db, svc } = setup();
    svc.register("payment-service");

    const agent = db.query("SELECT * FROM agents WHERE id = ?").get("payment-service") as Agent | null;
    expect(agent).not.toBeNull();
    expect(agent!.id).toBe("payment-service");

    db.close();
  });

  it("returns null for unregistered agent", () => {
    const { db } = setup();
    const agent = db.query("SELECT * FROM agents WHERE id = ?").get("nonexistent") as Agent | null;
    expect(agent).toBeNull();
    db.close();
  });

  it("migration adds pid and registered_at columns to agents", () => {
    const { db, svc } = setup();
    const agent = svc.register("test-agent");
    // pid and registered_at should exist (null until registration logic is updated)
    expect(agent).toHaveProperty("pid");
    expect(agent).toHaveProperty("registered_at");
    db.close();
  });

  it("stores pid and registered_at on registration", () => {
    const { db, svc } = setup();
    const agent = svc.register("code-reviewer");

    expect(agent.pid).toBe(process.pid);
    expect(agent.registered_at).toBeGreaterThan(0);
    db.close();
  });

  it("allows idempotent re-registration from same process", () => {
    const { db, svc } = setup();
    svc.register("code-reviewer");

    // Same PID re-registering — should succeed (idempotent)
    expect(() => svc.register("code-reviewer")).not.toThrow();
    db.close();
  });

  it("rejects duplicate name when existing process is alive (different PID)", () => {
    const { db, svc } = setup();
    svc.register("code-reviewer");

    // Set pid to PID 1 (init/launchd, always alive, different from test process)
    db.run("UPDATE agents SET pid = 1 WHERE id = ?", ["code-reviewer"]);

    expect(() => svc.register("code-reviewer")).toThrow("already active");
    db.close();
  });

  it("reclaims name when existing process is dead", () => {
    const { db, svc } = setup();
    svc.register("code-reviewer");

    // Manually set pid to a dead PID
    db.run("UPDATE agents SET pid = 999999 WHERE id = ?", ["code-reviewer"]);

    // Should reclaim since PID 999999 is (almost certainly) dead
    const reclaimed = svc.register("code-reviewer");
    expect(reclaimed.pid).toBe(process.pid);
    db.close();
  });

  it("reclaims name when PID is alive but last_seen_at is stale (PID reuse)", () => {
    const { db, svc } = setup();
    svc.register("code-reviewer");

    // Set pid to PID 1 (always alive) but last_seen_at to long ago
    const staleTime = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
    db.run("UPDATE agents SET pid = 1, last_seen_at = ? WHERE id = ?", [staleTime, "code-reviewer"]);

    // Should reclaim because last_seen_at is older than PID_STALE_MS (15 minutes)
    const reclaimed = svc.register("code-reviewer");
    expect(reclaimed.pid).toBe(process.pid);
    db.close();
  });

  it("rejects names with invalid characters", () => {
    const { db, svc } = setup();
    expect(() => svc.register("bad name")).toThrow("must match");
    expect(() => svc.register("bad.name")).toThrow("must match");
    db.close();
  });
});
