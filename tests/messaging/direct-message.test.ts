import { describe, it, expect, afterEach } from "bun:test";
import { allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { MessagingService } from "../../src/core/messaging/service";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";

const TEST_DB = testDbPath("dm");

function setup() {
  const db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid);
  return { db, svc };
}

afterEach(() => { cleanupDb(TEST_DB); });

describe("directMessage", () => {
  it("creates deterministic channel name (sorted agent IDs)", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");

    svc.directMessage("agent-a", "agent-b", "hello");

    const channels = db.query("SELECT name FROM channels").all() as { name: string }[];
    expect(channels).toHaveLength(1);
    // Sorted: agent-a < agent-b lexicographically
    expect(channels[0]!.name).toBe("agent-a,agent-b");

    db.close();
  });

  it("both agents subscribed (have cursors) after DM", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");

    svc.directMessage("agent-a", "agent-b", "hello");

    // Both agents should be able to read without error
    expect(() => svc.read("agent-a", "agent-a,agent-b")).not.toThrow();
    expect(() => svc.read("agent-b", "agent-a,agent-b")).not.toThrow();

    db.close();
  });

  it("idempotent — second DM reuses channel", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");

    svc.directMessage("agent-a", "agent-b", "first");
    svc.directMessage("agent-a", "agent-b", "second");

    const channels = db.query("SELECT name FROM channels").all() as { name: string }[];
    expect(channels).toHaveLength(1);

    db.close();
  });

  it("DM to self throws 'Cannot DM yourself'", () => {
    const { db, svc } = setup();
    svc.register("agent-a");

    expect(() => svc.directMessage("agent-a", "agent-a", "hello")).toThrow("Cannot DM yourself");

    db.close();
  });

  it("DM to nonexistent agent throws 'not found'", () => {
    const { db, svc } = setup();
    svc.register("agent-a");

    expect(() => svc.directMessage("agent-a", "agent-z", "hello")).toThrow("not found");

    db.close();
  });

  it("channel in DM mode — only 2 cursors exist", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.register("agent-b");

    svc.directMessage("agent-a", "agent-b", "hello");

    const channel = db.query("SELECT id FROM channels WHERE name = ?").get("agent-a,agent-b") as { id: number };
    const cursors = db.query("SELECT * FROM cursors WHERE channel_id = ?").all(channel.id) as unknown[];
    expect(cursors).toHaveLength(2);

    db.close();
  });
});
