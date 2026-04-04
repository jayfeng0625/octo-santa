import { describe, it, expect, afterEach } from "bun:test";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";
import { messagingMigrations, registerAgent, getAgent } from "../../src/modules/messaging/tools";
import type { Agent } from "../../src/modules/messaging/types";

const TEST_DB = testDbPath("register");

function setupDb() {
  return setupTestDb(TEST_DB, messagingMigrations);
}

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("registerAgent", () => {
  it("registers a new agent", () => {
    const db = setupDb();
    const result = registerAgent(db, "octo-santa");

    expect(result.id).toBe("octo-santa");
    expect(result.created_at).toBeGreaterThan(0);
    expect(result.last_seen_at).toBe(result.created_at);

    db.close();
  });

  it("is idempotent — second register updates last_seen_at", () => {
    const db = setupDb();
    const first = registerAgent(db, "octo-santa");

    // Small delay to ensure different timestamp
    const second = registerAgent(db, "octo-santa");
    expect(second.id).toBe("octo-santa");
    expect(second.last_seen_at).toBeGreaterThanOrEqual(first.last_seen_at);

    db.close();
  });

  it("can retrieve a registered agent", () => {
    const db = setupDb();
    registerAgent(db, "payment-service");

    const agent = getAgent(db, "payment-service");
    expect(agent).not.toBeNull();
    expect(agent!.id).toBe("payment-service");

    db.close();
  });

  it("returns null for unregistered agent", () => {
    const db = setupDb();
    const agent = getAgent(db, "nonexistent");
    expect(agent).toBeNull();
    db.close();
  });

  it("migration adds pid and registered_at columns to agents", () => {
    const db = setupDb();
    const agent = registerAgent(db, "test-agent");
    // pid and registered_at should exist (null until registration logic is updated)
    expect(agent).toHaveProperty("pid");
    expect(agent).toHaveProperty("registered_at");
    db.close();
  });

  it("stores pid and registered_at on registration", () => {
    const db = setupDb();
    const agent = registerAgent(db, "code-reviewer");

    expect(agent.pid).toBe(process.pid);
    expect(agent.registered_at).toBeGreaterThan(0);
    db.close();
  });

  it("allows idempotent re-registration from same process", () => {
    const db = setupDb();
    registerAgent(db, "code-reviewer");

    // Same PID re-registering — should succeed (idempotent)
    expect(() => registerAgent(db, "code-reviewer")).not.toThrow();
    db.close();
  });

  it("rejects duplicate name when existing process is alive (different PID)", () => {
    const db = setupDb();
    registerAgent(db, "code-reviewer");

    // Set pid to PID 1 (init/launchd, always alive, different from test process)
    db.run("UPDATE agents SET pid = 1 WHERE id = ?", ["code-reviewer"]);

    expect(() => registerAgent(db, "code-reviewer")).toThrow("already active");
    db.close();
  });

  it("reclaims name when existing process is dead", () => {
    const db = setupDb();
    registerAgent(db, "code-reviewer");

    // Manually set pid to a dead PID
    db.run("UPDATE agents SET pid = 999999 WHERE id = ?", ["code-reviewer"]);

    // Should reclaim since PID 999999 is (almost certainly) dead
    const reclaimed = registerAgent(db, "code-reviewer");
    expect(reclaimed.pid).toBe(process.pid);
    db.close();
  });

  it("reclaims name when PID is alive but last_seen_at is stale (PID reuse)", () => {
    const db = setupDb();
    registerAgent(db, "code-reviewer");

    // Set pid to PID 1 (always alive) but last_seen_at to long ago
    const staleTime = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
    db.run("UPDATE agents SET pid = 1, last_seen_at = ? WHERE id = ?", [staleTime, "code-reviewer"]);

    // Should reclaim because last_seen_at is older than PID_STALE_MS (15 minutes)
    const reclaimed = registerAgent(db, "code-reviewer");
    expect(reclaimed.pid).toBe(process.pid);
    db.close();
  });

  it("rejects names with invalid characters", () => {
    const db = setupDb();
    expect(() => registerAgent(db, "bad name")).toThrow("must match");
    expect(() => registerAgent(db, "bad.name")).toThrow("must match");
    db.close();
  });
});
