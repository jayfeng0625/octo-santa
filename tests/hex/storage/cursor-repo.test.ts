import { describe, it, expect, afterEach } from "bun:test";
import { SqliteCursorRepo } from "../../../src/storage/sqlite/cursor-repo";
import { SqliteMessageRepo } from "../../../src/storage/sqlite/message-repo";
import { SqliteAgentRepo } from "../../../src/storage/sqlite/agent-repo";
import { SqliteChannelRepo } from "../../../src/storage/sqlite/channel-repo";
import { createDb } from "../../../src/storage/sqlite/db";
import { runMigrations, allMigrations } from "../../../src/storage/sqlite/migrations";
import { cleanupDb } from "../../helpers/db";

const TEST_DB = `/tmp/octo-santa-test-hex-cursor-repo-${process.pid}.sqlite`;

function setup() {
  cleanupDb(TEST_DB);
  const db = createDb(TEST_DB);
  runMigrations(db, allMigrations);
  const agents = new SqliteAgentRepo(db);
  const channels = new SqliteChannelRepo(db);
  const cursors = new SqliteCursorRepo(db);
  const messages = new SqliteMessageRepo(db);
  agents.register("agent-a", process.pid);
  agents.register("agent-b", process.pid);
  const ch = channels.create("coordination", "agent-a");
  return { db, cursors, messages, channelId: ch.id };
}

afterEach(() => cleanupDb(TEST_DB));

describe("SqliteCursorRepo", () => {
  it("get returns 0 when no cursor exists", () => {
    const { db, cursors, channelId } = setup();
    expect(cursors.get("agent-a", channelId)).toBe(0);
    db.close();
  });

  it("listForAgent returns subscribed channels with cursor positions", () => {
    const { db, cursors, messages, channelId } = setup();
    // Seed agent-a's cursor through the production write path: another agent
    // sends a message, then agent-a reads forward, advancing its cursor.
    const sent = messages.insertAndJoinSender(channelId, "agent-b", "hello", []);
    messages.readForwardAndAdvance("agent-a", channelId, 50);
    const list = cursors.listForAgent("agent-a");
    expect(list.length).toBe(1);
    expect(list[0]!.channelId).toBe(channelId);
    expect(list[0]!.channelName).toBe("coordination");
    expect(list[0]!.lastReadMessageId).toBe(sent.id);
    db.close();
  });

  // I1 — Gap#1: per-ACK single-step cursor advance (the ACK primitive the SQLite
  // PubSub pump() calls per delivered message). NOT batch advance, no self-exclude.
  describe("set — per-ACK cursor advance (I1)", () => {
    it("persists the cursor to exactly the given message id (single-step)", () => {
      const { db, cursors, channelId } = setup();
      expect(cursors.get("agent-a", channelId)).toBe(0);
      cursors.set("agent-a", channelId, 5);
      expect(cursors.get("agent-a", channelId)).toBe(5);
      // ACKing one more advances exactly one step, never in a batch.
      cursors.set("agent-a", channelId, 6);
      expect(cursors.get("agent-a", channelId)).toBe(6);
      db.close();
    });

    it("holds on NACK and releases the next message only after ACK (HOL)", () => {
      const { db, cursors, messages, channelId } = setup();
      const m1 = messages.insertAndJoinSender(channelId, "agent-b", "m1", []);
      const m2 = messages.insertAndJoinSender(channelId, "agent-b", "m2", []);
      messages.insertAndJoinSender(channelId, "agent-b", "m3", []);

      // Forward read from the held cursor (no author filter — mirrors the seam pump).
      const nextUnread = (): number | null =>
        (
          db
            .query(
              "SELECT id FROM messages WHERE channel_id = ? AND id > ? ORDER BY id ASC LIMIT 1"
            )
            .get(channelId, cursors.get("agent-a", channelId)) as { id: number } | null
        )?.id ?? null;

      // cursor at 0 → next to deliver is m1
      expect(nextUnread()).toBe(m1.id);
      // NACK m1 (do NOT advance) → re-read re-yields m1; m2 withheld behind it (HOL)
      expect(nextUnread()).toBe(m1.id);
      // ACK m1 → advance one step → next is m2
      cursors.set("agent-a", channelId, m1.id);
      expect(nextUnread()).toBe(m2.id);
      db.close();
    });

    it("advancing never drops the caller's own messages from a forward read (no self-exclude)", () => {
      const { db, cursors, messages, channelId } = setup();
      const fromB = messages.insertAndJoinSender(channelId, "agent-b", "b1", []);
      const ownA = messages.insertAndJoinSender(channelId, "agent-a", "a-own", []);
      // ACK agent-b's message → advance cursor past it.
      cursors.set("agent-a", channelId, fromB.id);
      const rows = db
        .query(
          "SELECT id, agent_id FROM messages WHERE channel_id = ? AND id > ? ORDER BY id ASC"
        )
        .all(channelId, cursors.get("agent-a", channelId)) as {
        id: number;
        agent_id: string;
      }[];
      expect(rows.some((r) => r.id === ownA.id && r.agent_id === "agent-a")).toBe(true);
      db.close();
    });
  });

  // I2 — Gap#2: listForAgent is a membership-driving read (the readAllUnread pull-drain),
  // so it must exclude channels the agent has unsubscribed from (subscribed=0).
  describe("listForAgent — subscribed filter (I2)", () => {
    it("excludes channels the agent has unsubscribed from", () => {
      const { db, cursors, messages, channelId } = setup();
      messages.insertAndJoinSender(channelId, "agent-b", "hi", []);
      messages.readForwardAndAdvance("agent-a", channelId, 50); // creates agent-a's cursor row
      expect(cursors.listForAgent("agent-a").length).toBe(1);

      db.run(
        "UPDATE cursors SET subscribed = 0 WHERE agent_id = 'agent-a' AND channel_id = ?",
        [channelId]
      );
      expect(cursors.listForAgent("agent-a").length).toBe(0);
      db.close();
    });
  });
});
