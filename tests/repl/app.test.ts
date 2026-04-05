// tests/repl/app.test.ts
import { describe, it, expect, afterEach } from "bun:test";
import { allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { MessagingService } from "../../src/core/messaging/service";
import { InputBuffer } from "../../src/transports/repl/buffer";
import { KeyParser } from "../../src/transports/repl/keys";
import { parseCommand, executeCommand, type ReplState } from "../../src/transports/repl/commands";
import { formatMessage } from "../../src/transports/repl/renderer";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";

const TEST_DB = testDbPath("app");

function setup() {
  const db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid);
  return { db, svc, channelRepo: repos.channels };
}

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("REPL integration", () => {
  it("full send-receive cycle: buffer → keys → send → poll", () => {
    const { db, svc } = setup();
    svc.register("jay");
    svc.register("agent-a");
    svc.createChannel("jay", "planning");
    const buffer = new InputBuffer();
    const parser = new KeyParser({ kittyEnabled: false });

    // Simulate typing "hello"
    const actions = parser.parse(Buffer.from("hello"));
    for (const a of actions) {
      if (a.type === "insert") buffer.insert(a.text);
    }
    expect(buffer.getText()).toBe("hello");

    // Submit
    const text = buffer.submit();
    const msg = svc.send("jay", "planning", text);
    expect(msg.content).toBe("hello");

    // Poll — another agent's message
    svc.send("agent-a", "planning", "hey there");

    // Cursor must NOT be set to msg.id — that's the self-echo bug the spec warns about.
    // Set cursor to 0 so the poll picks up all non-self messages.
    const state: ReplState = {
      activeChannel: "planning",
      joinedChannels: new Set(["planning"]),
      cursors: new Map([["planning", 0]]),
      agentId: "jay",
    };

    // Direct SQL poll (same as app.ts)
    const rows = db.query(
      `SELECT m.id, m.agent_id, m.content, ch.name as channel_name
       FROM messages m
       JOIN channels ch ON m.channel_id = ch.id
       WHERE ch.name = ? AND m.id > ? AND m.agent_id != ?
       ORDER BY m.id ASC LIMIT 50`
    ).all("planning", state.cursors.get("planning")!, "jay") as any[];

    expect(rows.length).toBe(1);
    expect(rows[0].agent_id).toBe("agent-a");
    expect(rows[0].content).toBe("hey there");
  });

  it("command disambiguation: single-line /join is command, /path is message", () => {
    expect(parseCommand("/join planning")).not.toBeNull();
    expect(parseCommand("/path/to/file")).toBeNull();
  });

  it("multiline submit is never a command", () => {
    const buffer = new InputBuffer();
    buffer.insert("/join planning\nmore text");
    const text = buffer.submit();
    // Contains newline — should not be treated as command
    expect(text.includes("\n")).toBe(true);
    expect(parseCommand(text)).toBeNull(); // parseCommand only works on single-line
  });

  it("Kitty Shift+Enter inserts newline, Enter submits", () => {
    const parser = new KeyParser({ kittyEnabled: true });

    // Shift+Enter
    const a1 = parser.parse(Buffer.from("\x1b[13;2u"));
    expect(a1).toEqual([{ type: "insert", text: "\n" }]);

    // Plain Enter
    const a2 = parser.parse(Buffer.from([0x0d]));
    expect(a2).toEqual([{ type: "submit" }]);
  });

  it("/history includes own messages", () => {
    const { db, svc, channelRepo } = setup();
    svc.register("jay");
    svc.register("other");
    svc.createChannel("jay", "planning");
    svc.send("jay", "planning", "my own msg");
    svc.send("other", "planning", "their msg");

    const state: ReplState = {
      activeChannel: "planning",
      joinedChannels: new Set(["planning"]),
      cursors: new Map(),
      agentId: "jay",
    };

    const result = executeCommand({ name: "history", args: "10" }, svc, channelRepo, state);
    expect(result.messages).toBeDefined();
    expect(result.messages!.some(m => m.content === "my own msg")).toBe(true);
    expect(result.messages!.some(m => m.content === "their msg")).toBe(true);
  });

  it("poll excludes self messages", () => {
    const { db, svc } = setup();
    svc.register("jay");
    svc.register("agent-a");
    svc.createChannel("jay", "planning");
    const m1 = svc.send("jay", "planning", "my message");
    svc.send("agent-a", "planning", "their message");

    const rows = db.query(
      `SELECT agent_id, content FROM messages m
       JOIN channels ch ON m.channel_id = ch.id
       WHERE ch.name = ? AND m.id > ? AND m.agent_id != ?
       ORDER BY m.id ASC LIMIT 50`
    ).all("planning", 0, "jay") as { agent_id: string; content: string }[];

    expect(rows.length).toBe(1);
    expect(rows[0]!.agent_id).toBe("agent-a");
  });
});
