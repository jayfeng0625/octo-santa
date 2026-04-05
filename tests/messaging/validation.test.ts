import { describe, it, expect, afterEach } from "bun:test";
import { allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { MessagingService } from "../../src/core/messaging/service";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";

const TEST_DB = testDbPath("validation");

function setup() {
  const db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid);
  return { db, svc };
}

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("input validation", () => {
  it("rejects empty agent_id", () => {
    const { db, svc } = setup();
    expect(() => svc.register("")).toThrow();
    db.close();
  });

  it("rejects whitespace-only agent_id", () => {
    const { db, svc } = setup();
    expect(() => svc.register("   ")).toThrow();
    db.close();
  });

  it("rejects empty channel name", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    expect(() => svc.createChannel("agent-a", "")).toThrow();
    db.close();
  });

  it("rejects empty message content", () => {
    const { db, svc } = setup();
    expect(() => svc.send("agent-a", "general", "")).toThrow();
    db.close();
  });

  it("rejects whitespace-only message content", () => {
    const { db, svc } = setup();
    expect(() => svc.send("agent-a", "general", "   ")).toThrow();
    db.close();
  });

  it("rejects invalid agent_id characters on createChannel", () => {
    const { db, svc } = setup();
    expect(() => svc.createChannel("bad name", "ch")).toThrow("must match");
    db.close();
  });

  it("rejects invalid agent_id characters on sendMessage", () => {
    const { db, svc } = setup();
    expect(() => svc.send("bad.name", "ch", "test")).toThrow("must match");
    db.close();
  });

  it("readMessages rejects unregistered agent (requireRegistered validates agent name)", () => {
    const { db, svc } = setup();
    // requireRegistered calls validateAgentName, so invalid names throw before DB check
    expect(() => svc.read("bad@name", "ch")).toThrow("must match");
    db.close();
  });

  it("rejects reserved name 'all' on createChannel", () => {
    const { db, svc } = setup();
    expect(() => svc.createChannel("all", "ch")).toThrow("reserved");
    db.close();
  });

  it("rejects reserved name 'here' on sendMessage", () => {
    const { db, svc } = setup();
    expect(() => svc.send("here", "ch", "test")).toThrow("reserved");
    db.close();
  });

  it("readMessages rejects reserved agent name 'all'", () => {
    const { db, svc } = setup();
    // requireRegistered runs validateAgentName which rejects reserved names
    expect(() => svc.read("all", "ch")).toThrow("reserved");
    db.close();
  });
});
