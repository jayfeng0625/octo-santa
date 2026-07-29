import type { Database } from "bun:sqlite";
import type { MessageWithChannel } from "../../core/messaging/types";

// Storage-internal queries for the cross-process notification poller — not a
// core port, because polling is an adapter concern. Wired via closures in
// main.ts. Reads are transaction-free: WAL mode makes them non-blocking.
export class SqliteNotificationQueryRepo {
  constructor(private readonly db: Database) {}

  getNewMessagesForAgent(
    agentId: string,
    sinceId: number,
    limit: number
  ): MessageWithChannel[] {
    return this.db
      .query(
        `SELECT m.*, c.name AS channel_name
         FROM messages m
         JOIN cursors cm ON cm.channel_id = m.channel_id AND cm.agent_id = ?
         JOIN channels c ON c.id = m.channel_id
         WHERE m.id > ? AND m.agent_id != ?
         ORDER BY m.id ASC
         LIMIT ?`
      )
      .all(agentId, sinceId, agentId, limit) as MessageWithChannel[];
  }

  getMaxMessageId(): number {
    const row = this.db
      .query("SELECT COALESCE(MAX(id), 0) AS max_id FROM messages")
      .get() as { max_id: number };
    return row.max_id;
  }
}
