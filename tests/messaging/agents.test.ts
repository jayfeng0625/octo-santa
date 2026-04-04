import { describe, it, expect, afterEach } from "bun:test";
import {
  messagingMigrations,
  registerAgent,
  listAgents,
} from "../../src/modules/messaging/tools";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";

const TEST_DB = testDbPath("agents");

function setupDb() {
  return setupTestDb(TEST_DB, messagingMigrations);
}

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("listAgents", () => {
  it("returns empty list when no agents", () => {
    const db = setupDb();
    expect(listAgents(db)).toEqual([]);
    db.close();
  });

  it("returns only active agents by default", () => {
    const db = setupDb();
    registerAgent(db, "octo-santa");
    registerAgent(db, "payment-service");
    // Seed a stale agent with no PID
    db.run("INSERT INTO agents (id, created_at, last_seen_at) VALUES (?, ?, ?)", ["stale-agent", Date.now(), Date.now()]);

    const agents = listAgents(db);
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.id).sort()).toEqual(["octo-santa", "payment-service"]);

    db.close();
  });

  it("listAgents(db, true) returns all agents including stale", () => {
    const db = setupDb();
    registerAgent(db, "octo-santa");
    registerAgent(db, "payment-service");
    // Seed a stale agent with no PID
    db.run("INSERT INTO agents (id, created_at, last_seen_at) VALUES (?, ?, ?)", ["stale-agent", Date.now(), Date.now()]);

    const agents = listAgents(db, true);
    expect(agents).toHaveLength(3);
    expect(agents.map((a) => a.id).sort()).toEqual(["octo-santa", "payment-service", "stale-agent"]);

    db.close();
  });

  it("stale agents (no PID) are hidden by default", () => {
    const db = setupDb();
    // Only seed stale agents
    db.run("INSERT INTO agents (id, created_at, last_seen_at) VALUES (?, ?, ?)", ["stale-1", Date.now(), Date.now()]);
    db.run("INSERT INTO agents (id, created_at, last_seen_at) VALUES (?, ?, ?)", ["stale-2", Date.now(), Date.now()]);

    expect(listAgents(db)).toEqual([]);
    expect(listAgents(db, true)).toHaveLength(2);

    db.close();
  });
});
