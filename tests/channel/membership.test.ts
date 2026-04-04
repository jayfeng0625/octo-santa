import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  messagingMigrations,
  registerAgent,
  unregisterAgent,
  createChannel,
  sendMessage,
  readMessages,
  subscribe,
} from "../../src/modules/messaging/tools";
import { startPolling, type NotifyFn } from "../../src/channel";
import type { Database } from "bun:sqlite";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";

const TEST_DB = testDbPath("membership");

let db: Database;

beforeEach(() => {
  db = setupTestDb(TEST_DB, messagingMigrations);
});

afterEach(() => {
  db.close();
  cleanupDb(TEST_DB);
});

describe("unregistered agent does not affect DM notification mode", () => {
  it("agent gets notified for unmentioned messages when an unregistered member exists in channel", async () => {
    // Two MCP agents in a DM channel (name-based DM: agent-a,agent-b format)
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    registerAgent(db, "jay");
    createChannel(db, "agent-a,agent-b", "agent-a");
    sendMessage(db, "agent-a", "agent-a,agent-b", "setup");
    sendMessage(db, "agent-b", "agent-a,agent-b", "ack");

    // Jay sends a message then unregisters (simulates leaving session)
    sendMessage(db, "jay", "agent-a,agent-b", "one-off message");
    unregisterAgent(db, "jay", process.pid);

    // Subscribe agent-a to receive notifications
    subscribe(db, "agent-a", "agent-a,agent-b");
    readMessages(db, "agent-a", "agent-a,agent-b");

    // agent-b sends an unmentioned message — DM channel by name, both named agents are members
    sendMessage(db, "agent-b", "agent-a,agent-b", "status update — no mentions");

    // agent-a polls — should still get notified (DM mode based on channel name)
    const notifications: { content: string; meta: Record<string, string> }[] =
      [];
    const notify: NotifyFn = async (content, meta) => {
      notifications.push({ content, meta });
    };

    const stop = startPolling(db, "agent-a", notify, 50);
    await new Promise((r) => setTimeout(r, 200));
    await stop();

    expect(notifications.length).toBeGreaterThan(0);
    expect(
      notifications.some((n) => n.content.includes("status update"))
    ).toBe(true);
  });
});
