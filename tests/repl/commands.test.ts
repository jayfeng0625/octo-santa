import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { parseCommand, handleCommand, type ReplState } from "../../src/repl";
import { createDb } from "../../src/db";
import { runMigrations } from "../../src/migrations";
import {
  messagingMigrations,
  registerAgent,
  sendMessage,
  readMessages,
} from "../../src/modules/messaging/tools";

describe("parseCommand", () => {
  it("returns null for regular messages", () => {
    expect(parseCommand("hello world")).toBeNull();
  });

  it("parses command without args", () => {
    expect(parseCommand("/channels")).toEqual({ name: "channels", args: "" });
  });

  it("parses command with args", () => {
    expect(parseCommand("/join planning")).toEqual({ name: "join", args: "planning" });
  });

  it("parses command with multi-word args", () => {
    expect(parseCommand("/send -f path/to/file.md")).toEqual({
      name: "send",
      args: "-f path/to/file.md",
    });
  });

  it("parses /history with number", () => {
    expect(parseCommand("/history 20")).toEqual({ name: "history", args: "20" });
  });
});

const TEST_DB = "/tmp/octo-santa-test-commands.sqlite";

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

describe("handleCommand", () => {
  it("/channels lists channels with active marker", () => {
    const db = setupDb();
    sendMessage(db, "jay", "planning", "hello");
    sendMessage(db, "jay", "ops", "hello");
    const state: ReplState = { activeChannel: "planning", cursors: new Map([["planning", 0]]) };
    const output: string[] = [];

    handleCommand({ name: "channels", args: "" }, db, "jay", state, (t) => output.push(t));

    expect(output.join("\n")).toContain("planning (active)");
    expect(output.join("\n")).toContain("ops");
    db.close();
  });

  it("/agents lists registered agents", () => {
    const db = setupDb();
    registerAgent(db, "jay");
    registerAgent(db, "agent-a");
    const state: ReplState = { activeChannel: "planning", cursors: new Map([["planning", 0]]) };
    const output: string[] = [];

    handleCommand({ name: "agents", args: "" }, db, "jay", state, (t) => output.push(t));

    expect(output.join("\n")).toContain("jay");
    expect(output.join("\n")).toContain("agent-a");
    db.close();
  });

  it("/join switches active channel and initializes in-memory cursor", () => {
    const db = setupDb();
    sendMessage(db, "agent-a", "ops", "old msg 1");
    sendMessage(db, "agent-a", "ops", "old msg 2");
    const state: ReplState = { activeChannel: "planning", cursors: new Map([["planning", 0]]) };

    handleCommand({ name: "join", args: "ops" }, db, "jay", state, () => {});

    expect(state.activeChannel).toBe("ops");
    // In-memory cursor should exist and be set to max message id (skip old messages)
    expect(state.cursors.has("ops")).toBe(true);
    // No DB cursor row should be created for the human
    const cursor = db
      .query(
        `SELECT cr.* FROM cursors cr
         JOIN channels ch ON cr.channel_id = ch.id
         WHERE cr.agent_id = ? AND ch.name = ?`
      )
      .get("jay", "ops");
    expect(cursor).toBeNull();
    db.close();
  });

  it("/history shows recent messages from others", () => {
    const db = setupDb();
    sendMessage(db, "agent-a", "planning", "message one");
    sendMessage(db, "agent-a", "planning", "message two");
    sendMessage(db, "agent-a", "planning", "message three");
    const state: ReplState = { activeChannel: "planning", cursors: new Map([["planning", 0]]) };
    const output: string[] = [];

    handleCommand({ name: "history", args: "2" }, db, "jay", state, (t) => output.push(t));

    expect(output).toHaveLength(2);
    expect(output[0]).toContain("message two");
    expect(output[1]).toContain("message three");
    db.close();
  });

  it("/create creates channel without switching", () => {
    const db = setupDb();
    registerAgent(db, "jay");
    const state: ReplState = { activeChannel: "planning", cursors: new Map([["planning", 0]]) };
    const output: string[] = [];

    handleCommand({ name: "create", args: "ops" }, db, "jay", state, (t) => output.push(t));

    expect(state.activeChannel).toBe("planning");
    expect(output[0]).toContain("Created #ops");
    db.close();
  });

  it("/help lists available commands", () => {
    const db = setupDb();
    const state: ReplState = { activeChannel: "planning", cursors: new Map([["planning", 0]]) };
    const output: string[] = [];

    handleCommand({ name: "help", args: "" }, db, "jay", state, (t) => output.push(t));

    expect(output.join("\n")).toContain("/channels");
    expect(output.join("\n")).toContain("/quit");
    db.close();
  });

  it("unknown command returns true with error message", () => {
    const db = setupDb();
    const state: ReplState = { activeChannel: "planning", cursors: new Map([["planning", 0]]) };
    const output: string[] = [];

    const result = handleCommand({ name: "nope", args: "" }, db, "jay", state, (t) => output.push(t));

    expect(result).toBe(true);
    expect(output[0]).toContain("Unknown command");
    db.close();
  });

  it("/history with negative number uses default 20", () => {
    const db = setupDb();
    for (let i = 0; i < 25; i++) {
      sendMessage(db, "agent-a", "planning", `msg-${i}`);
    }
    const state: ReplState = { activeChannel: "planning", cursors: new Map([["planning", 0]]) };
    const output: string[] = [];

    handleCommand({ name: "history", args: "-1" }, db, "jay", state, (t) => output.push(t));

    expect(output.length).toBeLessThanOrEqual(20);
    db.close();
  });

  it("/history with zero uses default 20", () => {
    const db = setupDb();
    for (let i = 0; i < 25; i++) {
      sendMessage(db, "agent-a", "planning", `msg-${i}`);
    }
    const state: ReplState = { activeChannel: "planning", cursors: new Map([["planning", 0]]) };
    const output: string[] = [];

    handleCommand({ name: "history", args: "0" }, db, "jay", state, (t) => output.push(t));

    expect(output.length).toBeLessThanOrEqual(20);
    db.close();
  });

  it("/history with non-numeric uses default 20", () => {
    const db = setupDb();
    for (let i = 0; i < 25; i++) {
      sendMessage(db, "agent-a", "planning", `msg-${i}`);
    }
    const state: ReplState = { activeChannel: "planning", cursors: new Map([["planning", 0]]) };
    const output: string[] = [];

    handleCommand({ name: "history", args: "abc" }, db, "jay", state, (t) => output.push(t));

    expect(output.length).toBeLessThanOrEqual(20);
    db.close();
  });

  it("/members lists channel members with active/inactive status", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    sendMessage(db, "agent-a", "planning", "hello");
    // Create an inactive member (no PID)
    sendMessage(db, "human", "planning", "hi from repl");

    const state: ReplState = { activeChannel: "planning", cursors: new Map([["planning", 0]]) };
    const output: string[] = [];
    handleCommand({ name: "members", args: "" }, db, "agent-a", state, (t) => output.push(t));

    expect(output.length).toBeGreaterThan(0);
    expect(output.some((line) => line.includes("agent-a") && line.includes("(active)"))).toBe(true);
    expect(output.some((line) => line.includes("human") && line.includes("(inactive)"))).toBe(true);
    db.close();
  });

  it("/quit returns false to signal exit", () => {
    const db = setupDb();
    const state: ReplState = { activeChannel: "planning", cursors: new Map([["planning", 0]]) };

    const result = handleCommand({ name: "quit", args: "" }, db, "jay", state, () => {});

    expect(result).toBe(false);
    db.close();
  });
});
