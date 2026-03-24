import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { createDb } from "../../src/db";
import { runMigrations } from "../../src/migrations";
import {
  messagingMigrations,
  sendMessage,
} from "../../src/modules/messaging/tools";
import { pollTick, formatMessage, type ReplState } from "../../src/repl";

const TEST_DB = "/tmp/octo-santa-test-poll.sqlite";

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

afterEach(() => cleanupDb(TEST_DB));

describe("pollTick", () => {
  it("returns new messages from subscribed channels", () => {
    const db = setupDb();

    sendMessage(db, "agent-a", "planning", "hey jay");

    // Initialize in-memory state (cursor at 0 to see all messages)
    const state: ReplState = {
      activeChannel: "planning",
      cursors: new Map([["planning", 0]]),
    };
    const output: string[] = [];
    pollTick(db, "jay", state, (text) => output.push(text));

    expect(output).toHaveLength(1);
    expect(output[0]).toBe("[agent-a] hey jay");
    db.close();
  });

  it("shows messages from multiple channels with prefix", () => {
    const db = setupDb();

    sendMessage(db, "agent-a", "planning", "plan msg");
    sendMessage(db, "agent-b", "ops", "ops msg");

    // Track both channels in-memory
    const state: ReplState = {
      activeChannel: "planning",
      cursors: new Map([
        ["planning", 0],
        ["ops", 0],
      ]),
    };
    const output: string[] = [];
    pollTick(db, "jay", state, (text) => output.push(text));

    expect(output).toContain("[agent-a] plan msg");
    expect(output).toContain("[#ops][agent-b] ops msg");
    db.close();
  });

  it("advances cursor so same messages are not shown twice", () => {
    const db = setupDb();
    sendMessage(db, "agent-a", "planning", "first");

    const state: ReplState = {
      activeChannel: "planning",
      cursors: new Map([["planning", 0]]),
    };

    const out1: string[] = [];
    pollTick(db, "jay", state, (text) => out1.push(text));
    expect(out1).toHaveLength(1);

    const out2: string[] = [];
    pollTick(db, "jay", state, (text) => out2.push(text));
    expect(out2).toHaveLength(0);
    db.close();
  });
});
