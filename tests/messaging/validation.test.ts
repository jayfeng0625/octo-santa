import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { createDb } from "../../src/db";
import { runMigrations } from "../../src/migrations";
import { messagingMigrations, registerAgent, createChannel, sendMessage, readMessages } from "../../src/modules/messaging/tools";

const TEST_DB = "/tmp/octo-santa-test-validation.sqlite";

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

  it("rejects reserved name 'all' on readMessages", () => {
    const db = setupDb();
    expect(() => readMessages(db, "all", "ch")).toThrow("reserved");
    db.close();
  });
});
