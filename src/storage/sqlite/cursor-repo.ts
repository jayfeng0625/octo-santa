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

  /**
   * Per-ACK single-step advance (I1, Gap#1). Upsert the read position to exactly
   * `lastReadMessageId` — the id of the just-ACKed message. The caller (the SQLite
   * PubSub pump()) advances one step per ACK and holds on NACK (head-of-line), so this
   * is deliberately NOT a batch advance and does NOT self-exclude.
   */
  set(agentId: string, channelId: number, lastReadMessageId: number): void {
    const doSet = this.db.transaction(() => {
      this.db.run(
        `INSERT INTO cursors (agent_id, channel_id, last_read_message_id)
         VALUES (?, ?, ?)
         ON CONFLICT(agent_id, channel_id)
         DO UPDATE SET last_read_message_id = excluded.last_read_message_id`,
        [agentId, channelId, lastReadMessageId]
      );
    });
    withRetrySync(() => doSet.immediate());
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
