import type { Database } from "bun:sqlite";
import type { ChannelRepository } from "../../core/ports";
import type { Agent, Channel } from "../../core/messaging/types";
import { withRetrySync } from "./db";

export class SqliteChannelRepo implements ChannelRepository {
  constructor(private readonly db: Database) {}

  findByName(name: string): Channel | null {
    return (this.db.query("SELECT * FROM channels WHERE name = ?").get(name) as Channel) ?? null;
  }

  create(name: string, createdBy: string): Channel {
    return withRetrySync(() => {
      this.db.run(
        `INSERT INTO channels (name, created_by, created_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO NOTHING`,
        [name, createdBy, Date.now()]
      );
      return this.findByName(name) as Channel;
    });
  }

  list(): Channel[] {
    return this.db.query("SELECT * FROM channels ORDER BY name").all() as Channel[];
  }

  addMember(agentId: string, channelId: number, initialCursorId: number): void {
    withRetrySync(() => {
      this.db.run(
        `INSERT INTO cursors (agent_id, channel_id, last_read_message_id) VALUES (?, ?, ?)
         ON CONFLICT(agent_id, channel_id) DO NOTHING`,
        [agentId, channelId, initialCursorId]
      );
    });
  }

  getMembers(channelId: number): Agent[] {
    return this.db
      .query(
        `SELECT a.* FROM cursors cr
         JOIN agents a ON cr.agent_id = a.id
         WHERE cr.channel_id = ?
         ORDER BY a.id`
      )
      .all(channelId) as Agent[];
  }

  renameWithAnnouncement(channelId: number, newName: string, agentId: string): Channel {
    const doRename = this.db.transaction(() => {
      const existing = this.db.query("SELECT 1 FROM channels WHERE name = ?").get(newName);
      if (existing) throw new Error(`Channel "${newName}" already exists`);

      const oldChannel = this.db.query("SELECT * FROM channels WHERE id = ?").get(channelId) as Channel;
      const oldName = oldChannel.name;

      this.db.run("UPDATE channels SET name = ? WHERE id = ?", [newName, channelId]);

      this.db.run(
        "INSERT INTO messages (channel_id, agent_id, content, created_at, mentions) VALUES (?, ?, ?, ?, ?)",
        [channelId, "_system", `Channel renamed from "${oldName}" to "${newName}"`, Date.now(), '["*"]']
      );

      return this.db.query("SELECT * FROM channels WHERE id = ?").get(channelId) as Channel;
    });

    return withRetrySync(() => doRename.immediate());
  }
}
