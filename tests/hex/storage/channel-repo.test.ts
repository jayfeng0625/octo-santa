import { describe, it, expect, afterEach } from "bun:test";
import { SqliteChannelRepo } from "../../../src/storage/sqlite/channel-repo";
import { SqliteAgentRepo } from "../../../src/storage/sqlite/agent-repo";
import { createDb } from "../../../src/storage/sqlite/db";
import { runMigrations, allMigrations } from "../../../src/storage/sqlite/migrations";
import { cleanupDb } from "../../helpers/db";

const TEST_DB = `/tmp/octo-santa-test-hex-channel-repo-${process.pid}.sqlite`;

function setup() {
  cleanupDb(TEST_DB);
  const db = createDb(TEST_DB);
  runMigrations(db, allMigrations);
  const agents = new SqliteAgentRepo(db);
  const channels = new SqliteChannelRepo(db);
  agents.register("agent-a", process.pid);
  return { db, agents, channels };
}

afterEach(() => cleanupDb(TEST_DB));

describe("SqliteChannelRepo", () => {
  it("creates and finds a channel", () => {
    const { db, channels } = setup();
    const ch = channels.create("coordination", "agent-a");
    expect(ch.name).toBe("coordination");
    expect(ch.created_by).toBe("agent-a");
    expect(channels.findByName("coordination")).not.toBeNull();
    db.close();
  });

  it("create is idempotent (ON CONFLICT DO NOTHING)", () => {
    const { db, channels } = setup();
    channels.create("coordination", "agent-a");
    const ch2 = channels.create("coordination", "agent-a");
    expect(ch2.name).toBe("coordination");
    db.close();
  });

  it("list returns all channels", () => {
    const { db, channels } = setup();
    channels.create("ch-a", "agent-a");
    channels.create("ch-b", "agent-a");
    expect(channels.list().length).toBe(2);
    db.close();
  });

  it("addMember adds cursor entry", () => {
    const { db, channels } = setup();
    const ch = channels.create("coordination", "agent-a");
    channels.addMember("agent-a", ch.id, 0);
    expect(channels.getMemberCount(ch.id)).toBe(1);
    db.close();
  });

  it("getMembers returns agent rows", () => {
    const { db, channels } = setup();
    const ch = channels.create("coordination", "agent-a");
    channels.addMember("agent-a", ch.id, 0);
    const members = channels.getMembers(ch.id);
    expect(members.length).toBe(1);
    expect(members[0]!.id).toBe("agent-a");
    db.close();
  });

  it("getMaxMessageId returns 0 when no messages", () => {
    const { db, channels } = setup();
    const ch = channels.create("coordination", "agent-a");
    expect(channels.getMaxMessageId(ch.id)).toBe(0);
    db.close();
  });

  it("renameWithAnnouncement renames and inserts system message", () => {
    const { db, channels } = setup();
    const ch = channels.create("old-name", "agent-a");
    channels.addMember("agent-a", ch.id, 0);
    const renamed = channels.renameWithAnnouncement(ch.id, "new-name", "agent-a");
    expect(renamed.name).toBe("new-name");
    const msgs = db.query("SELECT * FROM messages WHERE channel_id = ?").all(ch.id) as { content: string; mentions: string }[];
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.content).toContain("renamed");
    expect(msgs[0]!.mentions).toBe('["*"]');
    db.close();
  });
});
