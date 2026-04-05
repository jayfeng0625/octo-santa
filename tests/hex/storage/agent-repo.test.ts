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

  it("findById returns agent or null", () => {
    const { db, repo } = setup();
    expect(repo.findById("nonexistent")).toBeNull();
    repo.register("test-agent", process.pid);
    expect(repo.findById("test-agent")).not.toBeNull();
    db.close();
  });

  it("listAll returns all agents", () => {
    const { db, repo } = setup();
    repo.register("agent-a", process.pid);
    const all = repo.listAll();
    expect(all.length).toBe(1);
    expect(all[0]!.id).toBe("agent-a");
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
