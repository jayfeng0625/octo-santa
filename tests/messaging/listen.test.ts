import { describe, it, expect, afterEach } from "bun:test";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";
import { allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { MessagingService } from "../../src/core/messaging/service";
import { registerMessagingTools } from "../../src/transports/mcp-stdio/adapter";

const TEST_DB = testDbPath("listen");

afterEach(() => {
  cleanupDb(TEST_DB);
});

function setup() {
  const db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid);

  const handlers: Record<string, (...args: any[]) => Promise<any>> = {};
  const mockServer = {
    registerTool: (name: string, _config: unknown, cb: (...args: any[]) => Promise<any>) => {
      handlers[name] = cb;
    },
  } as any;

  let bound: string | null = null;
  function onAgentId(agentId: string): { commit: (resolvedName?: string) => void } {
    if (bound !== null && bound !== agentId) {
      throw new Error(`Session already bound to agent "${bound}", cannot use "${agentId}"`);
    }
    return {
      commit: (resolvedName?: string) => { bound = resolvedName ?? agentId; },
    };
  }

  registerMessagingTools(mockServer, svc, onAgentId, undefined, undefined, repos.agents);
  return { db, svc, handlers };
}

describe("messaging_listen", () => {
  it("returns messages immediately when unread exist", async () => {
    const { db, svc, handlers } = setup();

    await handlers.messaging_register!({ agent_id: "alice" });
    svc.register("bob");
    await handlers.messaging_create_channel!({ agent_id: "alice", name: "general" });
    await handlers.messaging_subscribe!({ agent_id: "alice", channel: "general" });
    svc.subscribe("bob", "general");
    svc.send("bob", "general", "hello alice");

    const result = await handlers.messaging_listen!({ agent_id: "alice", timeout_ms: 5000 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.timed_out).toBe(false);
    expect(parsed.channels.length).toBeGreaterThan(0);
    expect(parsed.channels[0].channel).toBe("general");
    expect(parsed.channels[0].messages[0].content).toBe("hello alice");

    db.close();
  }, 10000);

  it("times out when no messages", async () => {
    const { db, handlers } = setup();

    await handlers.messaging_register!({ agent_id: "alice" });
    await handlers.messaging_create_channel!({ agent_id: "alice", name: "quiet" });
    await handlers.messaging_subscribe!({ agent_id: "alice", channel: "quiet" });

    const start = performance.now();
    const result = await handlers.messaging_listen!({ agent_id: "alice", timeout_ms: 1500 });
    const elapsed = performance.now() - start;

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.timed_out).toBe(true);
    expect(parsed.channels).toEqual([]);
    expect(elapsed).toBeGreaterThanOrEqual(1000);

    db.close();
  }, 10000);

  it("clamps timeout_ms below 1000 to 1000", async () => {
    const { db, handlers } = setup();

    await handlers.messaging_register!({ agent_id: "alice" });
    await handlers.messaging_create_channel!({ agent_id: "alice", name: "quiet2" });
    await handlers.messaging_subscribe!({ agent_id: "alice", channel: "quiet2" });

    const start = performance.now();
    const result = await handlers.messaging_listen!({ agent_id: "alice", timeout_ms: 100 });
    const elapsed = performance.now() - start;

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.timed_out).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(900);

    db.close();
  }, 10000);

  it("requires agent registration", async () => {
    const { db, handlers } = setup();

    let threw = false;
    try {
      await handlers.messaging_listen!({ agent_id: "unregistered", timeout_ms: 1500 });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    db.close();
  });
});
