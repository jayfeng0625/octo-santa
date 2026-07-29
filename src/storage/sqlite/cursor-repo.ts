import type { Database } from "bun:sqlite";
import type { CursorRepository } from "../../core/ports";
import type { CursorWithChannel } from "../../core/messaging/types";

export class SqliteCursorRepo implements CursorRepository {
  constructor(private db: Database) {}

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
