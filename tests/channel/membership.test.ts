import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { MessagingService } from "../../src/core/messaging/service";
import type { Database } from "bun:sqlite";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";

const TEST_DB = testDbPath("membership");

let db: Database;
let svc: MessagingService;

beforeEach(() => {
  db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  svc = new MessagingService(repos.agents, repos.channels, repos.messages, process.pid);
});

afterEach(() => {
  db.close();
  cleanupDb(TEST_DB);
});

describe("DM membership", () => {
  it("DM creates channel with both parties as members", () => {
    svc.register("agent-a");
    svc.register("agent-b");
    svc.directMessage("agent-a", "agent-b", "hello");

    const members = svc.listMembers("agent-a,agent-b");
    expect(members.map((m) => m.agent_id).sort()).toEqual(["agent-a", "agent-b"]);
  });

  it("3rd party cannot send on DM channel", () => {
    svc.register("agent-a");
    svc.register("agent-b");
    svc.register("jay");
    svc.directMessage("agent-a", "agent-b", "private");

    expect(() => svc.send("jay", "agent-a,agent-b", "intruding")).toThrow(
      'DM channel "agent-a,agent-b" is private to agent-a and agent-b'
    );
  });
});
