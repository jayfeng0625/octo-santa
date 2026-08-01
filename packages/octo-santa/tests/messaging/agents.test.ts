import { describe, it, expect, afterEach } from "bun:test";
import { allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { MessagingService } from "../../src/core/messaging/service";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";

const TEST_DB = testDbPath("agents");

function setup() {
  const db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(repos.agents, repos.channels, repos.messages, process.pid);
  return { db, svc };
}

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("listAgents", () => {
  it("returns empty list when no agents", () => {
    const { db, svc } = setup();
    expect(svc.listAgents()).toEqual([]);
    db.close();
  });

  it("returns only active agents by default", () => {
    const { db, svc } = setup();
    svc.register("octo-santa");
    svc.register("payment-service");
    // Seed a stale agent with no PID
    db.run("INSERT INTO agents (id, created_at, last_seen_at) VALUES (?, ?, ?)", ["stale-agent", Date.now(), Date.now()]);

    const agents = svc.listAgents();
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.id).sort()).toEqual(["octo-santa", "payment-service"]);

    db.close();
  });

  it("listAgents(true) returns all agents including stale", () => {
    const { db, svc } = setup();
    svc.register("octo-santa");
    svc.register("payment-service");
    // Seed a stale agent with no PID
    db.run("INSERT INTO agents (id, created_at, last_seen_at) VALUES (?, ?, ?)", ["stale-agent", Date.now(), Date.now()]);

    const agents = svc.listAgents(true);
    expect(agents).toHaveLength(3);
    expect(agents.map((a) => a.id).sort()).toEqual(["octo-santa", "payment-service", "stale-agent"]);

    db.close();
  });

  it("stale agents (no PID) are hidden by default", () => {
    const { db, svc } = setup();
    // Only seed stale agents
    db.run("INSERT INTO agents (id, created_at, last_seen_at) VALUES (?, ?, ?)", ["stale-1", Date.now(), Date.now()]);
    db.run("INSERT INTO agents (id, created_at, last_seen_at) VALUES (?, ?, ?)", ["stale-2", Date.now(), Date.now()]);

    expect(svc.listAgents()).toEqual([]);
    expect(svc.listAgents(true)).toHaveLength(2);

    db.close();
  });
});
