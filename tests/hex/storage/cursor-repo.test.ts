import { describe, it, expect, afterEach } from "bun:test";
import { SqliteCursorRepo } from "../../../src/storage/sqlite/cursor-repo";
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
  agents.register("agent-a", process.pid);
  const ch = channels.create("coordination", "agent-a");
  return { db, cursors, channelId: ch.id };
}

afterEach(() => cleanupDb(TEST_DB));

describe("SqliteCursorRepo", () => {
  it("get returns 0 when no cursor exists", () => {
    const { db, cursors, channelId } = setup();
    expect(cursors.get("agent-a", channelId)).toBe(0);
    db.close();
  });

  it("upsert creates and updates cursor", () => {
    const { db, cursors, channelId } = setup();
    cursors.upsert("agent-a", channelId, 5);
    expect(cursors.get("agent-a", channelId)).toBe(5);
    cursors.upsert("agent-a", channelId, 10);
    expect(cursors.get("agent-a", channelId)).toBe(10);
    db.close();
  });

  it("listForAgent returns subscribed channels with cursor positions", () => {
    const { db, cursors, channelId } = setup();
    cursors.upsert("agent-a", channelId, 5);
    const list = cursors.listForAgent("agent-a");
    expect(list.length).toBe(1);
    expect(list[0]!.channelId).toBe(channelId);
    expect(list[0]!.channelName).toBe("coordination");
    expect(list[0]!.lastReadMessageId).toBe(5);
    db.close();
  });
});
