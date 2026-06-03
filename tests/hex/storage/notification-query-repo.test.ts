import { describe, it, expect, afterEach } from "bun:test";
import { SqliteNotificationQueryRepo } from "../../../src/storage/sqlite/notification-query-repo";
import { SqliteAgentRepo } from "../../../src/storage/sqlite/agent-repo";
import { SqliteChannelRepo } from "../../../src/storage/sqlite/channel-repo";
import { SqliteMessageRepo } from "../../../src/storage/sqlite/message-repo";
import { allMigrations } from "../../../src/storage/sqlite/migrations";
import { cleanupDb, setupTestDb } from "../../helpers/db";

const TEST_DB = `/tmp/octo-santa-test-hex-notification-query-repo-${process.pid}.sqlite`;

function setup() {
  const db = setupTestDb(TEST_DB, allMigrations);
  const agents = new SqliteAgentRepo(db);
  const channels = new SqliteChannelRepo(db);
  const messages = new SqliteMessageRepo(db);
  const notifQuery = new SqliteNotificationQueryRepo(db);
  agents.register("agent-a", process.pid);
  agents.register("agent-b", process.pid);
  agents.register("agent-c", process.pid);
  return { db, agents, channels, messages, notifQuery };
}

afterEach(() => cleanupDb(TEST_DB));

describe("SqliteNotificationQueryRepo", () => {
  describe("getMaxMessageId", () => {
    it("returns 0 when no messages exist", () => {
      const { db, notifQuery } = setup();
      expect(notifQuery.getMaxMessageId()).toBe(0);
      db.close();
    });

    it("returns the highest message id after inserts", () => {
      const { db, channels, messages, notifQuery } = setup();
      const ch = channels.create("general", "agent-a");
      messages.insertAndJoinSender(ch.id, "agent-a", "msg-1", []);
      messages.insertAndJoinSender(ch.id, "agent-b", "msg-2", []);
      const m3 = messages.insertAndJoinSender(ch.id, "agent-a", "msg-3", []);
      expect(notifQuery.getMaxMessageId()).toBe(m3.id);
      db.close();
    });
  });

  describe("getNewMessagesForAgent", () => {
    it("returns empty array when no messages exist", () => {
      const { db, channels, notifQuery } = setup();
      channels.create("general", "agent-a");
      const result = notifQuery.getNewMessagesForAgent("agent-b", 0, 100);
      expect(result).toEqual([]);
      db.close();
    });

    it("returns empty array when agent is not subscribed to any channel", () => {
      const { db, channels, messages, notifQuery } = setup();
      const ch = channels.create("general", "agent-a");
      // agent-b is NOT added as member; agent-a sends a message
      messages.insertAndJoinSender(ch.id, "agent-a", "hello", []);
      const result = notifQuery.getNewMessagesForAgent("agent-b", 0, 100);
      expect(result).toEqual([]);
      db.close();
    });

    it("returns messages in subscribed channels since sinceId", () => {
      const { db, channels, messages, notifQuery } = setup();
      const ch = channels.create("general", "agent-a");
      channels.addMember("agent-b", ch.id, 0);
      const m1 = messages.insertAndJoinSender(ch.id, "agent-a", "hello", []);
      const m2 = messages.insertAndJoinSender(ch.id, "agent-a", "world", []);

      const result = notifQuery.getNewMessagesForAgent("agent-b", 0, 100);
      expect(result.length).toBe(2);
      expect(result[0]!.id).toBe(m1.id);
      expect(result[0]!.content).toBe("hello");
      expect(result[0]!.channel_name).toBe("general");
      expect(result[1]!.id).toBe(m2.id);
      db.close();
    });

    it("excludes agent's own messages", () => {
      const { db, channels, messages, notifQuery } = setup();
      const ch = channels.create("general", "agent-a");
      channels.addMember("agent-b", ch.id, 0);
      messages.insertAndJoinSender(ch.id, "agent-b", "my own message", []);
      messages.insertAndJoinSender(ch.id, "agent-a", "someone else", []);

      const result = notifQuery.getNewMessagesForAgent("agent-b", 0, 100);
      expect(result.length).toBe(1);
      expect(result[0]!.content).toBe("someone else");
      db.close();
    });

    it("only returns messages with id > sinceId", () => {
      const { db, channels, messages, notifQuery } = setup();
      const ch = channels.create("general", "agent-a");
      channels.addMember("agent-b", ch.id, 0);
      const m1 = messages.insertAndJoinSender(ch.id, "agent-a", "old", []);
      const m2 = messages.insertAndJoinSender(ch.id, "agent-a", "new", []);

      // Use m1.id as hwm — should only return m2
      const result = notifQuery.getNewMessagesForAgent("agent-b", m1.id, 100);
      expect(result.length).toBe(1);
      expect(result[0]!.id).toBe(m2.id);
      expect(result[0]!.content).toBe("new");
      db.close();
    });

    it("respects the limit parameter", () => {
      const { db, channels, messages, notifQuery } = setup();
      const ch = channels.create("general", "agent-a");
      channels.addMember("agent-b", ch.id, 0);
      messages.insertAndJoinSender(ch.id, "agent-a", "msg-1", []);
      messages.insertAndJoinSender(ch.id, "agent-a", "msg-2", []);
      messages.insertAndJoinSender(ch.id, "agent-a", "msg-3", []);

      const result = notifQuery.getNewMessagesForAgent("agent-b", 0, 2);
      expect(result.length).toBe(2);
      db.close();
    });

    it("returns messages ordered by id ascending", () => {
      const { db, channels, messages, notifQuery } = setup();
      const ch = channels.create("general", "agent-a");
      channels.addMember("agent-b", ch.id, 0);
      const m1 = messages.insertAndJoinSender(ch.id, "agent-a", "first", []);
      const m2 = messages.insertAndJoinSender(ch.id, "agent-c", "second", []);
      const m3 = messages.insertAndJoinSender(ch.id, "agent-a", "third", []);

      const result = notifQuery.getNewMessagesForAgent("agent-b", 0, 100);
      expect(result.length).toBe(3);
      expect(result[0]!.id).toBe(m1.id);
      expect(result[1]!.id).toBe(m2.id);
      expect(result[2]!.id).toBe(m3.id);
      db.close();
    });

    it("returns messages across multiple subscribed channels with correct channel_name", () => {
      const { db, channels, messages, notifQuery } = setup();
      const ch1 = channels.create("general", "agent-a");
      const ch2 = channels.create("engineering", "agent-a");
      channels.addMember("agent-b", ch1.id, 0);
      channels.addMember("agent-b", ch2.id, 0);

      const m1 = messages.insertAndJoinSender(ch1.id, "agent-a", "in general", []);
      const m2 = messages.insertAndJoinSender(ch2.id, "agent-c", "in engineering", []);

      const result = notifQuery.getNewMessagesForAgent("agent-b", 0, 100);
      expect(result.length).toBe(2);

      const generalMsg = result.find((m) => m.id === m1.id)!;
      const engMsg = result.find((m) => m.id === m2.id)!;
      expect(generalMsg.channel_name).toBe("general");
      expect(engMsg.channel_name).toBe("engineering");
      db.close();
    });

    it("does not return messages from channels agent is not subscribed to", () => {
      const { db, channels, messages, notifQuery } = setup();
      const ch1 = channels.create("subscribed-channel", "agent-a");
      const ch2 = channels.create("other-channel", "agent-a");
      channels.addMember("agent-b", ch1.id, 0);
      // agent-b NOT added to ch2

      messages.insertAndJoinSender(ch1.id, "agent-a", "visible", []);
      messages.insertAndJoinSender(ch2.id, "agent-a", "invisible", []);

      const result = notifQuery.getNewMessagesForAgent("agent-b", 0, 100);
      expect(result.length).toBe(1);
      expect(result[0]!.content).toBe("visible");
      db.close();
    });

    it("mention filtering is NOT performed here — all messages in subscribed channels are returned", () => {
      const { db, channels, messages, notifQuery } = setup();
      const ch = channels.create("general", "agent-a");
      channels.addMember("agent-b", ch.id, 0);

      // No mention of agent-b, but should still be returned (poller decides relevance)
      messages.insertAndJoinSender(ch.id, "agent-a", "no mention here", []);
      messages.insertAndJoinSender(ch.id, "agent-a", "@agent-c only", ["agent-c"]);
      messages.insertAndJoinSender(ch.id, "agent-a", "@agent-b mentioned", ["agent-b"]);

      const result = notifQuery.getNewMessagesForAgent("agent-b", 0, 100);
      expect(result.length).toBe(3);
      db.close();
    });

    // I2 — Gap#2: cross-process push delivery must NOT reach an unsubscribed member
    // (the highest-risk ghost-leak surface).
    it("excludes an unsubscribed member from delivery (I2)", () => {
      const { db, channels, messages, notifQuery } = setup();
      const ch = channels.create("general", "agent-a");
      channels.addMember("agent-b", ch.id, 0);
      messages.insertAndJoinSender(ch.id, "agent-a", "hello", []);
      expect(notifQuery.getNewMessagesForAgent("agent-b", 0, 100).length).toBe(1);

      channels.unsubscribeMember("agent-b", ch.id);
      expect(notifQuery.getNewMessagesForAgent("agent-b", 0, 100).length).toBe(0);
      db.close();
    });
  });
});
