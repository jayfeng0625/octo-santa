import { describe, it, expect, afterEach } from "bun:test";
import { SqliteMessageRepo } from "../../../src/storage/sqlite/message-repo";
import { SqliteAgentRepo } from "../../../src/storage/sqlite/agent-repo";
import { SqliteChannelRepo } from "../../../src/storage/sqlite/channel-repo";
import { createDb } from "../../../src/storage/sqlite/db";
import { runMigrations, allMigrations } from "../../../src/storage/sqlite/migrations";
import { cleanupDb } from "../../helpers/db";

const TEST_DB = `/tmp/octo-santa-test-hex-message-repo-${process.pid}.sqlite`;

function setup() {
  cleanupDb(TEST_DB);
  const db = createDb(TEST_DB);
  runMigrations(db, allMigrations);
  const agents = new SqliteAgentRepo(db);
  const channels = new SqliteChannelRepo(db);
  const messages = new SqliteMessageRepo(db);
  agents.register("agent-a", process.pid);
  agents.register("agent-b", process.pid);
  const ch = channels.create("coordination", "agent-a");
  return { db, agents, channels, messages, channelId: ch.id };
}

afterEach(() => cleanupDb(TEST_DB));

describe("SqliteMessageRepo", () => {
  it("insertAndJoinSender inserts message and upserts sender cursor", () => {
    const { db, messages, channelId } = setup();
    const msg = messages.insertAndJoinSender(channelId, "agent-a", "hello", []);
    expect(msg.id).toBeGreaterThan(0);
    expect(msg.content).toBe("hello");
    expect(msg.agent_id).toBe("agent-a");
    const cursor = db.query("SELECT last_read_message_id FROM cursors WHERE agent_id = ? AND channel_id = ?").get("agent-a", channelId) as { last_read_message_id: number } | null;
    expect(cursor).not.toBeNull();
    expect(cursor!.last_read_message_id).toBe(0);
    db.close();
  });

  it("insertAndJoinSender stores mentions as JSON", () => {
    const { db, messages, channelId } = setup();
    const msg = messages.insertAndJoinSender(channelId, "agent-a", "@agent-b check", ["agent-b"]);
    expect(JSON.parse(msg.mentions)).toEqual(["agent-b"]);
    db.close();
  });

  it("readForwardAndAdvance reads messages and advances cursor", () => {
    const { db, messages, channels, channelId } = setup();
    channels.addMember("agent-b", channelId, 0);
    messages.insertAndJoinSender(channelId, "agent-a", "msg-1", []);
    messages.insertAndJoinSender(channelId, "agent-a", "msg-2", []);
    const read = messages.readForwardAndAdvance("agent-b", channelId, 100);
    expect(read.length).toBe(2);
    expect(read[0]!.content).toBe("msg-1");
    const read2 = messages.readForwardAndAdvance("agent-b", channelId, 100);
    expect(read2.length).toBe(0);
    db.close();
  });

  it("readBefore returns messages before id excluding agent", () => {
    const { db, messages, channelId } = setup();
    const m1 = messages.insertAndJoinSender(channelId, "agent-a", "msg-1", []);
    messages.insertAndJoinSender(channelId, "agent-b", "msg-2", []);
    messages.insertAndJoinSender(channelId, "agent-a", "msg-3", []);
    const read = messages.readBefore(channelId, m1.id + 3, 50, "agent-a");
    expect(read.length).toBe(1);
    expect(read[0]!.content).toBe("msg-2");
    db.close();
  });

  it("countSince and readSince work correctly", () => {
    const { db, messages, channelId } = setup();
    messages.insertAndJoinSender(channelId, "agent-a", "msg-1", []);
    messages.insertAndJoinSender(channelId, "agent-b", "msg-2", []);
    const count = messages.countSince(channelId, 0, "agent-a");
    expect(count).toBe(1);
    const read = messages.readSince(channelId, 0, 100, "agent-a");
    expect(read.length).toBe(1);
    expect(read[0]!.content).toBe("msg-2");
    db.close();
  });

  it("readRecent returns latest N messages in chronological order", () => {
    const { db, messages, channelId } = setup();
    messages.insertAndJoinSender(channelId, "agent-a", "msg-1", []);
    messages.insertAndJoinSender(channelId, "agent-b", "msg-2", []);
    messages.insertAndJoinSender(channelId, "agent-a", "msg-3", []);
    const recent = messages.readRecent(channelId, 2);
    expect(recent.length).toBe(2);
    expect(recent[0]!.content).toBe("msg-2");
    expect(recent[1]!.content).toBe("msg-3");
    db.close();
  });
});
