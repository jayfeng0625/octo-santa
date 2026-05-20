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

  it("create with default maxHops returns channel with max_hops = 50", () => {
    const { db, channels } = setup();
    const ch = channels.create("test-channel", "agent-a");
    expect(ch.max_hops).toBe(50);
    expect(ch.hop_count).toBe(0);
    db.close();
  });

  it("create with custom maxHops stores the provided value", () => {
    const { db, channels } = setup();
    const ch = channels.create("test-channel", "agent-a", 10);
    expect(ch.max_hops).toBe(10);
    expect(ch.hop_count).toBe(0);
    db.close();
  });

  it("checkAndIncrementHop - allowed at 0/4", () => {
    const { db, channels } = setup();
    const ch = channels.create("hop-channel", "agent-a", 4);
    const result = channels.checkAndIncrementHop(ch.id);
    expect(result.allowed).toBe(true);
    expect(result.hopCount).toBe(1);
    expect(result.maxHops).toBe(4);
    db.close();
  });

  it("checkAndIncrementHop - allowed at 3/4", () => {
    const { db, channels } = setup();
    const ch = channels.create("hop-channel", "agent-a", 4);
    // Manually set hop_count to 3
    db.run("UPDATE channels SET hop_count = 3 WHERE id = ?", [ch.id]);
    const result = channels.checkAndIncrementHop(ch.id);
    expect(result.allowed).toBe(true);
    expect(result.hopCount).toBe(4);
    expect(result.maxHops).toBe(4);
    db.close();
  });

  it("checkAndIncrementHop - blocked at 4/4", () => {
    const { db, channels } = setup();
    const ch = channels.create("hop-channel", "agent-a", 4);
    // Manually set hop_count to 4 (at limit)
    db.run("UPDATE channels SET hop_count = 4 WHERE id = ?", [ch.id]);
    const result = channels.checkAndIncrementHop(ch.id);
    expect(result.allowed).toBe(false);
    expect(result.hopCount).toBe(4);
    expect(result.maxHops).toBe(4);
    db.close();
  });

  it("checkAndIncrementHop - counter not incremented when blocked", () => {
    const { db, channels } = setup();
    const ch = channels.create("hop-channel", "agent-a", 4);
    db.run("UPDATE channels SET hop_count = 4 WHERE id = ?", [ch.id]);
    channels.checkAndIncrementHop(ch.id);
    const row = db.query("SELECT hop_count FROM channels WHERE id = ?").get(ch.id) as { hop_count: number };
    expect(row.hop_count).toBe(4);
    db.close();
  });

  it("resetHopCount resets hop_count to 0", () => {
    const { db, channels } = setup();
    const ch = channels.create("hop-channel", "agent-a", 4);
    db.run("UPDATE channels SET hop_count = 3 WHERE id = ?", [ch.id]);
    channels.resetHopCount(ch.id);
    const row = db.query("SELECT hop_count FROM channels WHERE id = ?").get(ch.id) as { hop_count: number };
    expect(row.hop_count).toBe(0);
    db.close();
  });

  it("bumpHopAllowance decrements hop_count by N", () => {
    const { db, channels } = setup();
    const ch = channels.create("hop-channel", "agent-a", 4);
    db.run("UPDATE channels SET hop_count = 3 WHERE id = ?", [ch.id]);
    const result = channels.bumpHopAllowance(ch.id, 2);
    expect(result.hopCount).toBe(1);
    expect(result.maxHops).toBe(4);
    expect(result.allowed).toBe(true);
    db.close();
  });

  it("bumpHopAllowance clamps hop_count to 0, not negative", () => {
    const { db, channels } = setup();
    const ch = channels.create("hop-channel", "agent-a", 4);
    db.run("UPDATE channels SET hop_count = 2 WHERE id = ?", [ch.id]);
    const result = channels.bumpHopAllowance(ch.id, 10);
    expect(result.hopCount).toBe(0);
    expect(result.allowed).toBe(true);
    db.close();
  });

  it("bumpHopAllowance returns new state after decrement", () => {
    const { db, channels } = setup();
    const ch = channels.create("hop-channel", "agent-a", 5);
    db.run("UPDATE channels SET hop_count = 5 WHERE id = ?", [ch.id]);
    const result = channels.bumpHopAllowance(ch.id, 1);
    expect(result.hopCount).toBe(4);
    expect(result.maxHops).toBe(5);
    expect(result.allowed).toBe(true);
    db.close();
  });
});
