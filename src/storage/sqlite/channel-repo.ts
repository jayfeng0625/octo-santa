import type { Database } from "bun:sqlite";
import type { ChannelRepository } from "../../core/ports";
import type { Agent, Channel, HopCheckResult } from "../../core/messaging/types";
import { DEFAULT_MAX_HOPS } from "../../core/messaging/types";
import { withRetrySync } from "./db";

export class SqliteChannelRepo implements ChannelRepository {
  constructor(private readonly db: Database) {}

  findByName(name: string): Channel | null {
    return (this.db.query("SELECT * FROM channels WHERE name = ?").get(name) as Channel) ?? null;
  }

  create(name: string, createdBy: string, maxHops?: number): Channel {
    const effectiveMaxHops = maxHops ?? DEFAULT_MAX_HOPS;
    return withRetrySync(() => {
      this.db.run(
        `INSERT INTO channels (name, created_by, created_at, max_hops) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO NOTHING`,
        [name, createdBy, Date.now(), effectiveMaxHops]
      );
      return this.findByName(name) as Channel;
    });
  }

  list(): Channel[] {
    return this.db.query("SELECT * FROM channels ORDER BY name").all() as Channel[];
  }

  addMember(agentId: string, channelId: number, initialCursorId: number): void {
    withRetrySync(() => {
      // I2 — Gap#2: re-subscribe REACTIVATES (subscribed 0→1) while preserving the held
      // read position — DO UPDATE touches only `subscribed`, never last_read_message_id
      // (stop-only resume, spec §2.4). A brand-new row rides the column default (1).
      this.db.run(
        `INSERT INTO cursors (agent_id, channel_id, last_read_message_id) VALUES (?, ?, ?)
         ON CONFLICT(agent_id, channel_id) DO UPDATE SET subscribed = 1`,
        [agentId, channelId, initialCursorId]
      );
    });
  }

  // I2 — Gap#2: stop-only unsubscribe (sole writer of subscribed=0). Drops membership/
  // delivery but PRESERVES the cursor so re-subscribe resumes from the held position.
  unsubscribeMember(agentId: string, channelId: number): void {
    withRetrySync(() => {
      this.db.run(
        "UPDATE cursors SET subscribed = 0 WHERE agent_id = ? AND channel_id = ?",
        [agentId, channelId]
      );
    });
  }

  getMembers(channelId: number): Agent[] {
    // I2 — Gap#2: membership-read surface filters subscribed=1 (unsubscribed → ghost leak).
    return this.db
      .query(
        `SELECT a.* FROM cursors cr
         JOIN agents a ON cr.agent_id = a.id
         WHERE cr.channel_id = ? AND cr.subscribed = 1
         ORDER BY a.id`
      )
      .all(channelId) as Agent[];
  }

  getMemberCount(channelId: number): number {
    // I2 — Gap#2: its OWN subscribed=1 filter (separate COUNT, not folded into getMembers).
    const row = this.db
      .query("SELECT COUNT(*) as count FROM cursors WHERE channel_id = ? AND subscribed = 1")
      .get(channelId) as { count: number };
    return row.count;
  }

  checkAndIncrementHop(channelId: number): HopCheckResult {
    const doCheck = this.db.transaction(() => {
      const row = this.db.query("SELECT hop_count, max_hops FROM channels WHERE id = ?").get(channelId) as { hop_count: number; max_hops: number };
      if (row.hop_count < row.max_hops) {
        this.db.run("UPDATE channels SET hop_count = hop_count + 1 WHERE id = ?", [channelId]);
        return { allowed: true, hopCount: row.hop_count + 1, maxHops: row.max_hops };
      }
      return { allowed: false, hopCount: row.hop_count, maxHops: row.max_hops };
    });
    return withRetrySync(() => doCheck.immediate());
  }

  resetHopCount(channelId: number): void {
    withRetrySync(() => {
      this.db.run("UPDATE channels SET hop_count = 0 WHERE id = ?", [channelId]);
    });
  }

  bumpHopAllowance(channelId: number, amount: number): HopCheckResult {
    const doBump = this.db.transaction(() => {
      this.db.run("UPDATE channels SET hop_count = MAX(0, hop_count - ?) WHERE id = ?", [amount, channelId]);
      const row = this.db.query("SELECT hop_count, max_hops FROM channels WHERE id = ?").get(channelId) as { hop_count: number; max_hops: number };
      return { allowed: row.hop_count < row.max_hops, hopCount: row.hop_count, maxHops: row.max_hops };
    });
    return withRetrySync(() => doBump.immediate());
  }

  renameWithAnnouncement(channelId: number, newName: string, agentId: string): Channel {
    const doRename = this.db.transaction(() => {
      // Check new name isn't taken
      const existing = this.db.query("SELECT 1 FROM channels WHERE name = ?").get(newName);
      if (existing) throw new Error(`Channel "${newName}" already exists`);

      const oldChannel = this.db.query("SELECT * FROM channels WHERE id = ?").get(channelId) as Channel;
      const oldName = oldChannel.name;

      this.db.run("UPDATE channels SET name = ? WHERE id = ?", [newName, channelId]);

      // Notify all members via a system message with @all mention
      const now = Date.now();
      this.db.run(
        "INSERT INTO messages (channel_id, agent_id, content, created_at, mentions) VALUES (?, ?, ?, ?, ?)",
        [channelId, "_system", `Channel renamed from "${oldName}" to "${newName}"`, now, '["*"]']
      );

      return this.db.query("SELECT * FROM channels WHERE id = ?").get(channelId) as Channel;
    });

    return withRetrySync(() => doRename.immediate());
  }
}
