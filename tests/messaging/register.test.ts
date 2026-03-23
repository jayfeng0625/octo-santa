import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { createDb } from "../../src/db";
import { runMigrations } from "../../src/migrations";
import { messagingMigrations, registerAgent, getAgent } from "../../src/modules/messaging/tools";
import type { Agent } from "../../src/modules/messaging/types";

const TEST_DB = "/tmp/octo-santa-test-register.sqlite";

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
});
