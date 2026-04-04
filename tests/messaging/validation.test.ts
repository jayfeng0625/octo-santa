import { describe, it, expect, afterEach } from "bun:test";
import { messagingMigrations, registerAgent, createChannel, sendMessage, readMessages } from "../../src/modules/messaging/tools";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";

const TEST_DB = testDbPath("validation");

function setupDb() {
  return setupTestDb(TEST_DB, messagingMigrations);
}

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("input validation", () => {
  it("rejects empty agent_id", () => {
    const db = setupDb();
    expect(() => registerAgent(db, "")).toThrow();
    db.close();
  });

  it("rejects whitespace-only agent_id", () => {
    const db = setupDb();
    expect(() => registerAgent(db, "   ")).toThrow();
    db.close();
  });

  it("rejects empty channel name", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    expect(() => createChannel(db, "", "agent-a")).toThrow();
    db.close();
  });

  it("rejects empty message content", () => {
    const db = setupDb();
    expect(() => sendMessage(db, "agent-a", "general", "")).toThrow();
    db.close();
  });

  it("rejects whitespace-only message content", () => {
    const db = setupDb();
    expect(() => sendMessage(db, "agent-a", "general", "   ")).toThrow();
    db.close();
  });

  it("rejects invalid agent_id characters on createChannel", () => {
    const db = setupDb();
    expect(() => createChannel(db, "ch", "bad name")).toThrow("must match");
    db.close();
  });

  it("rejects invalid agent_id characters on sendMessage", () => {
    const db = setupDb();
    expect(() => sendMessage(db, "bad.name", "ch", "test")).toThrow("must match");
    db.close();
  });

  it("readMessages rejects unregistered agent (requireRegistered validates agent name)", () => {
    const db = setupDb();
    // requireRegistered calls validateAgentName, so invalid names throw before DB check
    expect(() => readMessages(db, "bad@name", "ch")).toThrow("must match");
    db.close();
  });

  it("rejects reserved name 'all' on createChannel", () => {
    const db = setupDb();
    expect(() => createChannel(db, "ch", "all")).toThrow("reserved");
    db.close();
  });

  it("rejects reserved name 'here' on sendMessage", () => {
    const db = setupDb();
    expect(() => sendMessage(db, "here", "ch", "test")).toThrow("reserved");
    db.close();
  });

  it("readMessages rejects reserved agent name 'all'", () => {
    const db = setupDb();
    // requireRegistered runs validateAgentName which rejects reserved names
    expect(() => readMessages(db, "all", "ch")).toThrow("reserved");
    db.close();
  });
});
