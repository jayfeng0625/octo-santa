import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { createDb } from "../../src/db";
import { runMigrations } from "../../src/migrations";
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

const TEST_DB = "/tmp/octo-santa-test-membership.sqlite";

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = path + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
}

let db: Database;

beforeEach(() => {
  cleanupDb(TEST_DB);
  db = createDb(TEST_DB);
  runMigrations(db, messagingMigrations);
});

afterEach(() => {
  db.close();
  cleanupDb(TEST_DB);
});

describe("unregistered agent does not affect DM notification mode", () => {
  it("agent gets notified for unmentioned messages when an unregistered member exists in channel", async () => {
    // Two registered MCP agents in a channel (DM mode: 2 active members)
    registerAgent(db, "agent-a");
    registerAgent(db, "agent-b");
    registerAgent(db, "jay");
    createChannel(db, "planning", "agent-a");
    sendMessage(db, "agent-a", "planning", "setup");
    sendMessage(db, "agent-b", "planning", "ack");

    // Jay sends a message then unregisters (simulates leaving session)
    sendMessage(db, "jay", "planning", "one-off message");
    unregisterAgent(db, "jay", process.pid);

    // Subscribe agent-a to receive notifications
    subscribe(db, "agent-a", "planning");
    readMessages(db, "agent-a", "planning");

    // agent-b sends an unmentioned message — jay is unregistered, so only 2 active members (DM mode)
    sendMessage(db, "agent-b", "planning", "status update — no mentions");

    // agent-a polls — should still get notified (DM mode, not group)
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
