import type { Database } from "bun:sqlite";
import type { CursorRepository } from "../../core/ports";
import type { CursorWithChannel } from "../../core/messaging/types";
import { withRetrySync } from "./db";

export class SqliteCursorRepo implements CursorRepository {
  constructor(private db: Database) {}

  get(agentId: string, channelId: number): number {
    const row = this.db
      .query(
        "SELECT last_read_message_id FROM cursors WHERE agent_id = ? AND channel_id = ?"
      )
      .get(agentId, channelId) as { last_read_message_id: number } | null;
    return row?.last_read_message_id ?? 0;
  }

  upsert(agentId: string, channelId: number, messageId: number): void {
    withRetrySync(() => {
      this.db.run(
        `INSERT INTO cursors (agent_id, channel_id, last_read_message_id) VALUES (?, ?, ?)
         ON CONFLICT(agent_id, channel_id) DO UPDATE SET last_read_message_id = excluded.last_read_message_id`,
        [agentId, channelId, messageId]
      );
    });
  }

  listForAgent(agentId: string): CursorWithChannel[] {
    return this.db
      .query(
        `SELECT cr.channel_id as channelId, ch.name as channelName,
                cr.last_read_message_id as lastReadMessageId
         FROM cursors cr
         JOIN channels ch ON cr.channel_id = ch.id
         WHERE cr.agent_id = ?`
      )
      .all(agentId) as CursorWithChannel[];
  }
}
