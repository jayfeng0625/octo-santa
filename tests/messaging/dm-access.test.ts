import { describe, it, expect, afterEach } from "bun:test";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";
import {
  messagingMigrations,
  registerAgent,
  createChannel,
  subscribe,
  sendMessage,
  directMessage,
  renameChannel,
} from "../../src/modules/messaging/tools";

const TEST_DB = testDbPath("dm-access");

function setupDb() {
  return setupTestDb(TEST_DB, messagingMigrations);
}

afterEach(() => { cleanupDb(TEST_DB); });

describe("DM channel access control", () => {
  it("rejects subscribe from agent not in DM channel name", () => {
    const db = setupDb();
    registerAgent(db, "alice");
    registerAgent(db, "bob");
    registerAgent(db, "eve");
    directMessage(db, "alice", "bob", "private hello");

    expect(() => subscribe(db, "eve", "alice,bob")).toThrow(
      'DM channel "alice,bob" is private to alice and bob'
    );
  });

  it("rejects sendMessage from agent not in DM channel name", () => {
    const db = setupDb();
    registerAgent(db, "alice");
    registerAgent(db, "bob");
    registerAgent(db, "eve");
    directMessage(db, "alice", "bob", "private hello");

    expect(() => sendMessage(db, "eve", "alice,bob", "intruding")).toThrow(
      'DM channel "alice,bob" is private to alice and bob'
    );
  });

  it("allows named agents to subscribe to their DM channel", () => {
    const db = setupDb();
    registerAgent(db, "alice");
    registerAgent(db, "bob");
    directMessage(db, "alice", "bob", "hello");

    // Both named agents can subscribe (idempotent — they already have cursors from DM)
    expect(() => subscribe(db, "alice", "alice,bob")).not.toThrow();
    expect(() => subscribe(db, "bob", "alice,bob")).not.toThrow();
  });

  it("allows named agents to send on their DM channel", () => {
    const db = setupDb();
    registerAgent(db, "alice");
    registerAgent(db, "bob");
    directMessage(db, "alice", "bob", "hello");

    const msg = sendMessage(db, "bob", "alice,bob", "reply");
    expect(msg.content).toBe("reply");
  });

  it("does not restrict regular channels (no comma pattern)", () => {
    const db = setupDb();
    registerAgent(db, "alice");
    registerAgent(db, "bob");
    registerAgent(db, "eve");
    createChannel(db, "general", "alice");
    subscribe(db, "bob", "general");

    // Eve can subscribe and send on regular channels
    expect(() => subscribe(db, "eve", "general")).not.toThrow();
    expect(() => sendMessage(db, "eve", "general", "hello from eve")).not.toThrow();
  });

  it("does not restrict channels with commas that aren't DM format", () => {
    const db = setupDb();
    registerAgent(db, "alice");
    registerAgent(db, "bob");
    createChannel(db, "a,b,c", "alice");
    subscribe(db, "bob", "a,b,c");

    // 3-part comma name doesn't match DM pattern
    expect(() => sendMessage(db, "bob", "a,b,c", "hello")).not.toThrow();
  });

  it("rejects renaming a DM channel", () => {
    const db = setupDb();
    registerAgent(db, "alice");
    registerAgent(db, "bob");
    directMessage(db, "alice", "bob", "hello");

    expect(() => renameChannel(db, "alice", "alice,bob", "chat")).toThrow(
      "Cannot rename a DM channel"
    );
  });

  it("rejects renaming a regular channel to a DM-style name", () => {
    const db = setupDb();
    registerAgent(db, "alice");
    registerAgent(db, "bob");
    createChannel(db, "general", "alice");
    subscribe(db, "bob", "general");

    expect(() => renameChannel(db, "alice", "general", "alice,bob")).toThrow(
      "Cannot rename a channel to a DM-style name"
    );
  });

  it("does not treat unsorted pairs as DM channels (bob,alice)", () => {
    const db = setupDb();
    registerAgent(db, "alice");
    registerAgent(db, "bob");
    registerAgent(db, "eve");
    // Manually create a channel with unsorted DM-like name
    createChannel(db, "bob,alice", "alice");
    subscribe(db, "bob", "bob,alice");

    // Eve can join — unsorted pair is not recognized as DM
    expect(() => subscribe(db, "eve", "bob,alice")).not.toThrow();
  });

  it("does not treat self-pairs as DM channels (alice,alice)", () => {
    const db = setupDb();
    registerAgent(db, "alice");
    registerAgent(db, "eve");
    createChannel(db, "alice,alice", "alice");

    // Eve can join — self-pair is not a valid DM
    expect(() => subscribe(db, "eve", "alice,alice")).not.toThrow();
  });
});
