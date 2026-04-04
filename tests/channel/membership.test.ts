import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  messagingMigrations,
  registerAgent,
  unregisterAgent,
  createChannel,
  sendMessage,
  readMessages,
  subscribe,
  directMessage,
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

describe("DM notification mode", () => {
  it("DM channel push-all works for named agents without mentions", async () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    directMessage(db, "agent-a", "agent-b", "setup");
    readMessages(db, "agent-a", "agent-a,agent-b");

    // agent-b sends an unmentioned message — DM mode pushes to agent-a anyway
    sendMessage(db, "agent-b", "agent-a,agent-b", "status update — no mentions");

    const notifications: { content: string; meta: Record<string, string> }[] = [];
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

  it("3rd party cannot send on DM channel", () => {
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    registerAgent(db, "jay");
    directMessage(db, "agent-a", "agent-b", "private");

    expect(() => sendMessage(db, "jay", "agent-a,agent-b", "intruding")).toThrow(
      'DM channel "agent-a,agent-b" is private to agent-a and agent-b'
    );
  });
});
