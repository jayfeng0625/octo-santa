import { describe, it, expect, afterEach } from "bun:test";
import { unlinkSync, writeFileSync } from "fs";
import { allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { MessagingService } from "../../src/core/messaging/service";
import { parseCommand, executeCommand, KNOWN_COMMANDS } from "../../src/transports/repl/commands";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";

const TEST_DB = testDbPath("commands");

function setup() {
  const db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid);
  return { db, svc, channelRepo: repos.channels };
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
    const { db, svc, channelRepo } = setup();
    svc.register("user");
    svc.createChannel("user", "test-ch");
    const result = executeCommand(
      { name: "channels", args: "" },
      svc,
      channelRepo,
      { activeChannel: "test-ch", joinedChannels: new Set(["test-ch"]), cursors: new Map(), agentId: "user" }
    );
    expect(result.output.some(l => l.includes("test-ch"))).toBe(true);
  });

  it("/join switches active channel", () => {
    const { db, svc, channelRepo } = setup();
    svc.register("user");
    svc.createChannel("user", "new-ch");
    const state = { activeChannel: "old", joinedChannels: new Set(["old"]), cursors: new Map<string, number>(), agentId: "user" };
    const result = executeCommand({ name: "join", args: "new-ch" }, svc, channelRepo, state);
    expect(result.channelChange).toBe("new-ch");
  });

  it("/history shows messages including own", () => {
    const { db, svc, channelRepo } = setup();
    svc.register("user");
    svc.register("other");
    svc.createChannel("user", "test-ch");
    svc.send("user", "test-ch", "my message");
    svc.send("other", "test-ch", "their message");
    const state = { activeChannel: "test-ch", joinedChannels: new Set(["test-ch"]), cursors: new Map(), agentId: "user" };
    const result = executeCommand({ name: "history", args: "10" }, svc, channelRepo, state);
    expect(result.messages).toBeDefined();
    expect(result.messages!.some(m => m.content === "my message")).toBe(true);
    expect(result.messages!.some(m => m.content === "their message")).toBe(true);
  });

  it("/history defaults to 20 for invalid N", () => {
    const { db, svc, channelRepo } = setup();
    svc.register("user");
    svc.createChannel("user", "test-ch");
    // Insert 25 messages so the limit is exercised
    for (let i = 0; i < 25; i++) svc.send("user", "test-ch", `msg-${i}`);
    const state = { activeChannel: "test-ch", joinedChannels: new Set(["test-ch"]), cursors: new Map(), agentId: "user" };
    const result = executeCommand({ name: "history", args: "abc" }, svc, channelRepo, state);
    expect(result.messages!.length).toBe(20);
  });

  it("/quit sets exit flag", () => {
    const { db, svc, channelRepo } = setup();
    const state = { activeChannel: "ch", joinedChannels: new Set(["ch"]), cursors: new Map(), agentId: "user" };
    const result = executeCommand({ name: "quit", args: "" }, svc, channelRepo, state);
    expect(result.exit).toBe(true);
  });

  it("/create creates channel without switching", () => {
    const { db, svc, channelRepo } = setup();
    svc.register("user");
    const state = { activeChannel: "old", joinedChannels: new Set(["old"]), cursors: new Map<string, number>(), agentId: "user" };
    const result = executeCommand({ name: "create", args: "new-ch" }, svc, channelRepo, state);
    expect(result.output.some(l => l.includes("new-ch"))).toBe(true);
    expect(result.channelChange).toBeUndefined();
    expect(state.activeChannel).toBe("old");
  });

  it("/agents lists agents", () => {
    const { db, svc, channelRepo } = setup();
    svc.register("agent-a");
    const state = { activeChannel: "test-ch", joinedChannels: new Set(["test-ch"]), cursors: new Map(), agentId: "user" };
    const result = executeCommand({ name: "agents", args: "" }, svc, channelRepo, state);
    expect(result.output.some(l => l.includes("agent-a"))).toBe(true);
  });

  it("/members lists channel members", () => {
    const { db, svc, channelRepo } = setup();
    svc.register("agent-a");
    svc.createChannel("agent-a", "test-ch");
    svc.send("agent-a", "test-ch", "hi");
    const state = { activeChannel: "test-ch", joinedChannels: new Set(["test-ch"]), cursors: new Map(), agentId: "user" };
    const result = executeCommand({ name: "members", args: "" }, svc, channelRepo, state);
    expect(result.output.some(l => l.includes("agent-a"))).toBe(true);
  });

  it("/send -f sends file and returns localEcho", () => {
    const { db, svc, channelRepo } = setup();
    svc.register("user");
    svc.createChannel("user", "test-ch");
    const tmpFile = "/tmp/octo-santa-test-send-f.txt";
    writeFileSync(tmpFile, "file content here");
    const state = { activeChannel: "test-ch", joinedChannels: new Set(["test-ch"]), cursors: new Map(), agentId: "user" };
    const result = executeCommand({ name: "send", args: `-f ${tmpFile}` }, svc, channelRepo, state);
    expect(result.localEcho?.content).toBe("file content here");
    unlinkSync(tmpFile);
  });

  it("/join adds channel to joinedChannels", () => {
    const { db, svc, channelRepo } = setup();
    svc.register("user");
    svc.register("other");
    svc.createChannel("other", "target-ch");
    svc.send("other", "target-ch", "msg1");
    svc.send("other", "target-ch", "msg2");
    const state = { activeChannel: "old", joinedChannels: new Set(["old"]), cursors: new Map<string, number>(), agentId: "user" };
    executeCommand({ name: "join", args: "target-ch" }, svc, channelRepo, state);
    expect(state.joinedChannels.has("target-ch")).toBe(true);
  });

  it("/history 0 falls back to 20", () => {
    const { db, svc, channelRepo } = setup();
    svc.register("user");
    svc.createChannel("user", "test-ch");
    for (let i = 0; i < 25; i++) svc.send("user", "test-ch", `msg-${i}`);
    const state = { activeChannel: "test-ch", joinedChannels: new Set(["test-ch"]), cursors: new Map(), agentId: "user" };
    const result = executeCommand({ name: "history", args: "0" }, svc, channelRepo, state);
    expect(result.messages!.length).toBe(20);
  });

  it("/history -1 falls back to 20", () => {
    const { db, svc, channelRepo } = setup();
    svc.register("user");
    svc.createChannel("user", "test-ch");
    for (let i = 0; i < 25; i++) svc.send("user", "test-ch", `msg-${i}`);
    const state = { activeChannel: "test-ch", joinedChannels: new Set(["test-ch"]), cursors: new Map(), agentId: "user" };
    const result = executeCommand({ name: "history", args: "-1" }, svc, channelRepo, state);
    expect(result.messages!.length).toBe(20);
  });

  it("/help returns help text", () => {
    const { db, svc, channelRepo } = setup();
    const state = { activeChannel: "ch", joinedChannels: new Set(["ch"]), cursors: new Map(), agentId: "user" };
    const result = executeCommand({ name: "help", args: "" }, svc, channelRepo, state);
    expect(result.output.length).toBeGreaterThan(0);
  });
});
