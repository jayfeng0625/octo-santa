import type { Database } from "bun:sqlite";
import type { MessageRepository } from "../../core/ports";
import type { Message } from "../../core/messaging/types";
import { withRetrySync } from "./db";

export class SqliteMessageRepo implements MessageRepository {
  constructor(private readonly db: Database) {}

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

      // ON CONFLICT DO NOTHING preserves an existing cursor so the sender
      // doesn't skip unread messages from others.
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

  // Read-cursor + fetch + cursor-advance in one immediate transaction so a
  // concurrent reader in another process cannot double-consume the batch.
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
}
