import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { createDb } from "../../src/db";
import { runMigrations } from "../../src/migrations";
import {
  messagingMigrations,
  registerAgent,
  sendMessage,
  createChannel,
} from "../../src/modules/messaging/tools";
import { parseCommand, executeCommand, KNOWN_COMMANDS } from "../../src/repl/commands";

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

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("parseCommand", () => {
  it("parses known command", () => {
    expect(parseCommand("/join planning")).toEqual({ name: "join", args: "planning" });
  });

  it("parses command with no args", () => {
    expect(parseCommand("/channels")).toEqual({ name: "channels", args: "" });
  });

  it("returns null for unknown slash token", () => {
    expect(parseCommand("/path/to/file")).toBeNull();
  });

  it("returns null for multiline input even if starts with known command", () => {
    expect(parseCommand("/join planning\nmore text")).toBeNull();
  });

  it("returns null for non-slash input", () => {
    expect(parseCommand("hello world")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseCommand("")).toBeNull();
  });
});

describe("executeCommand", () => {
  it("/channels lists channels", () => {
    const db = setupDb();
    registerAgent(db, "user");
    createChannel(db, "test-ch", "user");
    const result = executeCommand(
      { name: "channels", args: "" },
      db,
      { activeChannel: "test-ch", joinedChannels: new Set(["test-ch"]), cursors: new Map(), agentId: "user" }
    );
    expect(result.output.some(l => l.includes("test-ch"))).toBe(true);
  });

  it("/join switches active channel", () => {
    const db = setupDb();
    registerAgent(db, "user");
    createChannel(db, "new-ch", "user");
    const state = { activeChannel: "old", joinedChannels: new Set(["old"]), cursors: new Map<string, number>(), agentId: "user" };
    const result = executeCommand({ name: "join", args: "new-ch" }, db, state);
    expect(result.channelChange).toBe("new-ch");
  });

  it("/history shows messages including own", () => {
    const db = setupDb();
    registerAgent(db, "user");
    registerAgent(db, "other");
    createChannel(db, "test-ch", "user");
    sendMessage(db, "user", "test-ch", "my message");
    sendMessage(db, "other", "test-ch", "their message");
    const state = { activeChannel: "test-ch", joinedChannels: new Set(["test-ch"]), cursors: new Map(), agentId: "user" };
    const result = executeCommand({ name: "history", args: "10" }, db, state);
    expect(result.messages).toBeDefined();
    expect(result.messages!.some(m => m.content === "my message")).toBe(true);
    expect(result.messages!.some(m => m.content === "their message")).toBe(true);
  });

  it("/history defaults to 20 for invalid N", () => {
    const db = setupDb();
    registerAgent(db, "user");
    createChannel(db, "test-ch", "user");
    // Insert 25 messages so the limit is exercised
    for (let i = 0; i < 25; i++) sendMessage(db, "user", "test-ch", `msg-${i}`);
    const state = { activeChannel: "test-ch", joinedChannels: new Set(["test-ch"]), cursors: new Map(), agentId: "user" };
    const result = executeCommand({ name: "history", args: "abc" }, db, state);
    expect(result.messages!.length).toBe(20);
  });

  it("/quit sets exit flag", () => {
    const db = setupDb();
    const state = { activeChannel: "ch", joinedChannels: new Set(["ch"]), cursors: new Map(), agentId: "user" };
    const result = executeCommand({ name: "quit", args: "" }, db, state);
    expect(result.exit).toBe(true);
  });

  it("/create creates channel without switching", () => {
    const db = setupDb();
    registerAgent(db, "user");
    const state = { activeChannel: "old", joinedChannels: new Set(["old"]), cursors: new Map<string, number>(), agentId: "user" };
    const result = executeCommand({ name: "create", args: "new-ch" }, db, state);
    expect(result.output.some(l => l.includes("new-ch"))).toBe(true);
    expect(result.channelChange).toBeUndefined();
    expect(state.activeChannel).toBe("old");
  });

  it("/agents lists agents", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    const state = { activeChannel: "test-ch", joinedChannels: new Set(["test-ch"]), cursors: new Map(), agentId: "user" };
    const result = executeCommand({ name: "agents", args: "" }, db, state);
    expect(result.output.some(l => l.includes("agent-a"))).toBe(true);
  });

  it("/members lists channel members", () => {
    const db = setupDb();
    registerAgent(db, "agent-a");
    createChannel(db, "test-ch", "agent-a");
    sendMessage(db, "agent-a", "test-ch", "hi");
    const state = { activeChannel: "test-ch", joinedChannels: new Set(["test-ch"]), cursors: new Map(), agentId: "user" };
    const result = executeCommand({ name: "members", args: "" }, db, state);
    expect(result.output.some(l => l.includes("agent-a"))).toBe(true);
  });

  it("/send -f sends file and returns localEcho", () => {
    const db = setupDb();
    registerAgent(db, "user");
    createChannel(db, "test-ch", "user");
    const tmpFile = "/tmp/octo-santa-test-send-f.txt";
    writeFileSync(tmpFile, "file content here");
    const state = { activeChannel: "test-ch", joinedChannels: new Set(["test-ch"]), cursors: new Map(), agentId: "user" };
    const result = executeCommand({ name: "send", args: `-f ${tmpFile}` }, db, state);
    expect(result.localEcho?.content).toBe("file content here");
    unlinkSync(tmpFile);
  });

  it("/join adds channel to joinedChannels", () => {
    const db = setupDb();
    registerAgent(db, "user");
    registerAgent(db, "other");
    createChannel(db, "target-ch", "other");
    sendMessage(db, "other", "target-ch", "msg1");
    sendMessage(db, "other", "target-ch", "msg2");
    const state = { activeChannel: "old", joinedChannels: new Set(["old"]), cursors: new Map<string, number>(), agentId: "user" };
    executeCommand({ name: "join", args: "target-ch" }, db, state);
    expect(state.joinedChannels.has("target-ch")).toBe(true);
  });

  it("/history 0 falls back to 20", () => {
    const db = setupDb();
    registerAgent(db, "user");
    createChannel(db, "test-ch", "user");
    for (let i = 0; i < 25; i++) sendMessage(db, "user", "test-ch", `msg-${i}`);
    const state = { activeChannel: "test-ch", joinedChannels: new Set(["test-ch"]), cursors: new Map(), agentId: "user" };
    const result = executeCommand({ name: "history", args: "0" }, db, state);
    expect(result.messages!.length).toBe(20);
  });

  it("/history -1 falls back to 20", () => {
    const db = setupDb();
    registerAgent(db, "user");
    createChannel(db, "test-ch", "user");
    for (let i = 0; i < 25; i++) sendMessage(db, "user", "test-ch", `msg-${i}`);
    const state = { activeChannel: "test-ch", joinedChannels: new Set(["test-ch"]), cursors: new Map(), agentId: "user" };
    const result = executeCommand({ name: "history", args: "-1" }, db, state);
    expect(result.messages!.length).toBe(20);
  });

  it("/help returns help text", () => {
    const db = setupDb();
    const state = { activeChannel: "ch", joinedChannels: new Set(["ch"]), cursors: new Map(), agentId: "user" };
    const result = executeCommand({ name: "help", args: "" }, db, state);
    expect(result.output.length).toBeGreaterThan(0);
  });
});
