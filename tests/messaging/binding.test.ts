import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { createDb } from "../../src/db";
import { runMigrations } from "../../src/migrations";
import messaging from "../../src/modules/messaging";
import { messagingMigrations } from "../../src/modules/messaging/tools";

const TEST_DB = `/tmp/octo-santa-test-binding-${process.pid}.sqlite`;

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = path + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
}

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("agent binding enforcement", () => {
  function setup() {
    cleanupDb(TEST_DB);
    const db = createDb(TEST_DB);
    runMigrations(db, messagingMigrations);

    const handlers: Record<string, (...args: any[]) => Promise<any>> = {};
    const mockServer = {
      registerTool: (name: string, _config: unknown, cb: (...args: any[]) => Promise<any>) => {
        handlers[name] = cb;
      },
    } as any;

    let bound: string | null = null;
    function onAgentId(agentId: string) {
      if (bound !== null && bound !== agentId) {
        throw new Error(`Session already bound to agent "${bound}", cannot use "${agentId}"`);
      }
      bound = agentId;
    }

    messaging.registerTools(mockServer, () => db, onAgentId);
    return { db, handlers };
  }

  it("rejects mismatched agent_id on send WITHOUT persisting the message", async () => {
    const { db, handlers } = setup();
    await handlers.messaging_register!({ agent_id: "agent-a" });

    let threw = false;
    try {
      await handlers.messaging_send_message!({
        agent_id: "agent-b",
        channel: "coordination",
        content: "should not persist",
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    const rows = db.query("SELECT * FROM messages").all();
    expect(rows.length).toBe(0);
    db.close();
  });

  it("rejects mismatched agent_id on read WITHOUT creating a cursor", async () => {
    const { db, handlers } = setup();
    await handlers.messaging_register!({ agent_id: "agent-a" });

    let threw = false;
    try {
      await handlers.messaging_read_messages!({
        agent_id: "agent-b",
        channel: "coordination",
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    const cursors = db.query("SELECT * FROM cursors").all();
    expect(cursors.length).toBe(0);
    db.close();
  });

  it("allows same agent_id on subsequent calls", async () => {
    const { db, handlers } = setup();
    await handlers.messaging_register!({ agent_id: "agent-a" });

    const result = await handlers.messaging_send_message!({
      agent_id: "agent-a",
      channel: "coordination",
      content: "hello",
    });

    expect(result.content[0].text).toContain("hello");
    db.close();
  });
});
