import type { Database } from "bun:sqlite";
import type { Message } from "../../core/messaging/types";

/**
 * Storage-internal class for cross-process notification queries.
 * NOT a core port — polling is an adapter concern. This class is wired
 * via closures in main.ts and its methods are passed as raw functions
 * to the notification poller.
 */
export class SqliteNotificationQueryRepo {
  constructor(private readonly db: Database) {}

  /**
   * Returns messages newer than sinceId in all channels the agent is subscribed to,
   * excluding messages sent by the agent itself.
   * Uses cursors table as the channel membership table (one row per agent per channel).
   * Read-only — no transaction or retry needed in WAL mode.
   */
  getNewMessagesForAgent(
    agentId: string,
    sinceId: number,
    limit: number
  ): Array<Message & { channel_name: string }> {
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
      .all(agentId, sinceId, agentId, limit) as Array<Message & { channel_name: string }>;
  }

  /**
   * Returns the current maximum message id across all messages, or 0 if no messages exist.
   * Used to initialize the high-water mark for a new poller.
   * Read-only — no transaction or retry needed in WAL mode.
   */
  getMaxMessageId(): number {
    const row = this.db
      .query("SELECT COALESCE(MAX(id), 0) AS max_id FROM messages")
      .get() as { max_id: number };
    return row.max_id;
  }
}
