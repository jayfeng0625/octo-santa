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
});
