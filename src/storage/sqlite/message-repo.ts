import type { Database } from "bun:sqlite";
import type { MessageRepository } from "../../core/ports";
import type { Message } from "../../core/messaging/types";
import { withRetrySync } from "./db";

export class SqliteMessageRepo implements MessageRepository {
  constructor(private readonly db: Database) {}

  /**
   * Immediate transaction: INSERT message + upsert sender cursor to 0
   * (ON CONFLICT DO NOTHING — preserves existing cursor so sender doesn't
   * lose their read position if they've already been reading).
   * Mentions passed as pre-extracted string array, stored as JSON.
   */
  insertAndJoinSender(
    channelId: number,
    agentId: string,
    content: string,
    mentions: string[]
  ): Message {
    const doInsert = this.db.transaction(() => {
      const now = Date.now();
      const mentionsJson = JSON.stringify(mentions);

      this.db.run(
        "INSERT INTO messages (channel_id, agent_id, content, created_at, mentions) VALUES (?, ?, ?, ?, ?)",
        [channelId, agentId, content, now, mentionsJson]
      );

      const lastId = this.db.query("SELECT last_insert_rowid() as id").get() as { id: number };

      // Upsert cursor for sender: ON CONFLICT DO NOTHING preserves existing cursor
      // so sender doesn't skip unread messages from others.
      this.db.run(
        `INSERT INTO cursors (agent_id, channel_id, last_read_message_id)
         VALUES (?, ?, 0)
         ON CONFLICT(agent_id, channel_id) DO NOTHING`,
        [agentId, channelId]
      );

      return {
        id: lastId.id,
        channel_id: channelId,
        agent_id: agentId,
        content,
        created_at: now,
        mentions: mentionsJson,
      };
    });

    return withRetrySync(() => doInsert.immediate());
  }

  /**
   * Immediate transaction: read cursor internally, fetch messages WHERE id > cursor
   * AND agent_id != agentId, advance cursor. Fully atomic.
   */
  readForwardAndAdvance(agentId: string, channelId: number, limit: number): Message[] {
    const doRead = this.db.transaction(() => {
      const cursorRow = this.db
        .query("SELECT last_read_message_id FROM cursors WHERE agent_id = ? AND channel_id = ?")
        .get(agentId, channelId) as { last_read_message_id: number } | null;
      const lastReadId = cursorRow?.last_read_message_id ?? 0;

      const messages = this.db
        .query(
          `SELECT * FROM messages
           WHERE channel_id = ? AND id > ? AND agent_id != ?
           ORDER BY id ASC
           LIMIT ?`
        )
        .all(channelId, lastReadId, agentId, limit) as Message[];

      const cursorValue =
        messages.length > 0 ? messages[messages.length - 1]!.id : lastReadId;

      this.db.run(
        `INSERT INTO cursors (agent_id, channel_id, last_read_message_id)
         VALUES (?, ?, ?)
         ON CONFLICT(agent_id, channel_id)
         DO UPDATE SET last_read_message_id = excluded.last_read_message_id`,
        [agentId, channelId, cursorValue]
      );

      return messages;
    });

    return withRetrySync(() => doRead.immediate());
  }

  /**
   * DESC query + reverse for chronological order.
   * No cursor involvement — used for history scrollback.
   */
  readBefore(
    channelId: number,
    beforeId: number,
    limit: number,
    excludeAgent: string
  ): Message[] {
    const rows = this.db
      .query(
        `SELECT * FROM messages
         WHERE channel_id = ? AND id < ? AND agent_id != ?
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(channelId, beforeId, excludeAgent, limit) as Message[];
    return rows.reverse();
  }

  /**
   * DESC query + reverse for chronological order.
   * Any author (no excludeAgent). For REPL /history.
   */
  readRecent(channelId: number, limit: number): Message[] {
    const rows = this.db
      .query(
        `SELECT * FROM messages
         WHERE channel_id = ?
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(channelId, limit) as Message[];
    return rows.reverse();
  }

  /**
   * SELECT * WHERE id > sinceId AND agent_id != excludeAgent ORDER BY id ASC
   */
  readSince(
    channelId: number,
    sinceId: number,
    limit: number,
    excludeAgent: string
  ): Message[] {
    return this.db
      .query(
        `SELECT * FROM messages
         WHERE channel_id = ? AND id > ? AND agent_id != ?
         ORDER BY id ASC
         LIMIT ?`
      )
      .all(channelId, sinceId, excludeAgent, limit) as Message[];
  }
}
