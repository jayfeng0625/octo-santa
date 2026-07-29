import { describe, it, expect, afterEach } from "bun:test";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";
import { allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { MessagingService } from "../../src/core/messaging/service";

const TEST_DB = testDbPath("dm-access");

function setup() {
  const db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(repos.agents, repos.channels, repos.messages, process.pid);
  return { db, svc };
}

afterEach(() => { cleanupDb(TEST_DB); });

describe("DM channel access control", () => {
  it("rejects subscribe from agent not in DM channel name", () => {
    const { db, svc } = setup();
    svc.register("alice");
    svc.register("bob");
    svc.register("eve");
    svc.directMessage("alice", "bob", "private hello");

    expect(() => svc.subscribe("eve", "alice,bob")).toThrow(
      'DM channel "alice,bob" is private to alice and bob'
    );
  });

  it("rejects sendMessage from agent not in DM channel name", () => {
    const { db, svc } = setup();
    svc.register("alice");
    svc.register("bob");
    svc.register("eve");
    svc.directMessage("alice", "bob", "private hello");

    expect(() => svc.send("eve", "alice,bob", "intruding")).toThrow(
      'DM channel "alice,bob" is private to alice and bob'
    );
  });

  it("allows named agents to subscribe to their DM channel", () => {
    const { db, svc } = setup();
    svc.register("alice");
    svc.register("bob");
    svc.directMessage("alice", "bob", "hello");

    // Both named agents can subscribe (idempotent — they already have cursors from DM)
    expect(() => svc.subscribe("alice", "alice,bob")).not.toThrow();
    expect(() => svc.subscribe("bob", "alice,bob")).not.toThrow();
  });

  it("allows named agents to send on their DM channel", () => {
    const { db, svc } = setup();
    svc.register("alice");
    svc.register("bob");
    svc.directMessage("alice", "bob", "hello");

    const msg = svc.send("bob", "alice,bob", "reply");
    expect(msg.content).toBe("reply");
  });

  it("does not restrict regular channels (no comma pattern)", () => {
    const { db, svc } = setup();
    svc.register("alice");
    svc.register("bob");
    svc.register("eve");
    svc.createChannel("alice", "general");
    svc.subscribe("bob", "general");

    // Eve can subscribe and send on regular channels
    expect(() => svc.subscribe("eve", "general")).not.toThrow();
    expect(() => svc.send("eve", "general", "hello from eve")).not.toThrow();
  });

  it("does not restrict channels with commas that aren't DM format", () => {
    const { db, svc } = setup();
    svc.register("alice");
    svc.register("bob");
    svc.createChannel("alice", "a,b,c");
    svc.subscribe("bob", "a,b,c");

    // 3-part comma name doesn't match DM pattern
    expect(() => svc.send("bob", "a,b,c", "hello")).not.toThrow();
  });

  it("rejects renaming a DM channel", () => {
    const { db, svc } = setup();
    svc.register("alice");
    svc.register("bob");
    svc.directMessage("alice", "bob", "hello");

    expect(() => svc.renameChannel("alice", "alice,bob", "chat")).toThrow(
      "Cannot rename a DM channel"
    );
  });

  it("rejects renaming a regular channel to a DM-style name", () => {
    const { db, svc } = setup();
    svc.register("alice");
    svc.register("bob");
    svc.createChannel("alice", "general");
    svc.subscribe("bob", "general");

    expect(() => svc.renameChannel("alice", "general", "alice,bob")).toThrow(
      "Cannot rename a channel to a DM-style name"
    );
  });

  it("does not treat unsorted pairs as DM channels (bob,alice)", () => {
    const { db, svc } = setup();
    svc.register("alice");
    svc.register("bob");
    svc.register("eve");
    // Manually create a channel with unsorted DM-like name
    svc.createChannel("alice", "bob,alice");
    svc.subscribe("bob", "bob,alice");

    // Eve can join — unsorted pair is not recognized as DM
    expect(() => svc.subscribe("eve", "bob,alice")).not.toThrow();
  });

  it("does not treat self-pairs as DM channels (alice,alice)", () => {
    const { db, svc } = setup();
    svc.register("alice");
    svc.register("eve");
    svc.createChannel("alice", "alice,alice");

    // Eve can join — self-pair is not a valid DM
    expect(() => svc.subscribe("eve", "alice,alice")).not.toThrow();
  });
});
