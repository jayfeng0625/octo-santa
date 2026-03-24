// tests/repl/integration.test.ts
import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { createDb } from "../../src/db";
import { runMigrations } from "../../src/migrations";
import {
  messagingMigrations,
  sendMessage,
  readMessages,
} from "../../src/modules/messaging/tools";
import {
  parseArgs,
  formatMessage,
  parseCommand,
  handleCommand,
  pollTick,
  runSendMode,
  type ReplState,
} from "../../src/repl";

const TEST_DB = "/tmp/octo-santa-test-integration-repl.sqlite";
const TEST_FILE = "/tmp/octo-santa-test-integration-brief.md";

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
  if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);
});

describe("REPL integration", () => {
  it("full round-trip: human sends file, agent reads, agent replies, human polls", () => {
    const db = setupDb();

    // 1. Human sends a brief via file
    writeFileSync(TEST_FILE, "# Sprint Brief\n\nBuild the widget.");
    runSendMode(db, "jay", "planning", TEST_FILE);

    // 2. Agent reads the brief
    const agentInbox = readMessages(db, "agent-a", "planning");
    expect(agentInbox).toHaveLength(1);
    expect(agentInbox[0]!.content).toContain("Build the widget");
    expect(agentInbox[0]!.agent_id).toBe("jay");

    // 3. Human initializes in-memory cursor at max ID (simulates startRepl startup)
    const maxRow = db
      .query(
        `SELECT MAX(m.id) as max_id
         FROM messages m
         JOIN channels ch ON m.channel_id = ch.id
         WHERE ch.name = ?`
      )
      .get("planning") as { max_id: number | null } | null;
    const state: ReplState = {
      activeChannel: "planning",
      cursors: new Map([["planning", maxRow?.max_id ?? 0]]),
    };

    // 4. Agent replies (arrives after cursor was set)
    sendMessage(db, "agent-a", "planning", "@jay Got it, starting now.");

    // 5. Human polls and sees the reply (cursor was set before reply, so it's unread)
    const output: string[] = [];
    pollTick(db, "jay", state, (text) => output.push(text));
    expect(output).toHaveLength(1);
    expect(output[0]).toContain("agent-a");
    expect(output[0]).toContain("@jay Got it, starting now.");
    db.close();
  });

  it("multi-channel: human joins second channel, poll shows both", () => {
    const db = setupDb();

    // Human starts with planning channel (in-memory cursor)
    const state: ReplState = {
      activeChannel: "planning",
      cursors: new Map([["planning", 0]]),
    };

    // Human joins ops via /join
    handleCommand({ name: "join", args: "ops" }, db, "jay", state, () => {});

    // Messages arrive on both
    sendMessage(db, "agent-a", "planning", "plan update");
    sendMessage(db, "agent-b", "ops", "deploy done");

    // Poll should show both, with prefix on non-active
    const output: string[] = [];
    pollTick(db, "jay", state, (text) => output.push(text));

    expect(output).toContain("[#planning][agent-a] plan update");
    expect(output).toContain("[agent-b] deploy done"); // ops is active, no prefix
    db.close();
  });
});
