import type { Database } from "bun:sqlite";
import type { CursorRepository } from "../../core/ports";
import type { CursorWithChannel } from "../../core/messaging/types";
import { withRetrySync } from "./db";

export class SqliteCursorRepo implements CursorRepository {
  constructor(private db: Database) {}

  // I10 — F4: this is the PUSH delivery cursor (`delivery_cursor`), SEPARATE from the PULL read
  // cursor (`last_read_message_id`, advanced by readForwardAndAdvance / read_messages). The push
  // pump reads from here and includes self-authored messages; sharing one column with the pull
  // cursor caused silent loss when both surfaces ran on one channel.
  //
  // I2 — Gap#2 EXEMPT: specific-agent position read, keyed (agent,channel). NOT a membership
  // enumeration — deliberately NOT filtered by `subscribed`, so an unsubscribed agent's held
  // push position survives for stop-only resume (filtering here would corrupt it).
  get(agentId: string, channelId: number): number {
    const row = this.db
      .query(
        "SELECT delivery_cursor FROM cursors WHERE agent_id = ? AND channel_id = ?"
      )
      .get(agentId, channelId) as { delivery_cursor: number } | null;
    return row?.delivery_cursor ?? 0;
  }

  // I10 — F4: the PULL read cursor (`last_read_message_id`), SEPARATE from the push delivery
  // cursor above. read_messages (readForwardAndAdvance) advances it; the REPL restores its
  // backlog position from it on reconnect. Reading it here never touches the push cursor.
  getRead(agentId: string, channelId: number): number {
    const row = this.db
      .query(
        "SELECT last_read_message_id FROM cursors WHERE agent_id = ? AND channel_id = ?"
      )
      .get(agentId, channelId) as { last_read_message_id: number } | null;
    return row?.last_read_message_id ?? 0;
  }

  /**
   * Per-ACK single-step advance of the PUSH delivery cursor (I1, Gap#1). Upsert the position to
   * the id of the just-ACKed message. The caller (the SQLite PubSub pump()) advances one step per
   * ACK and holds on NACK (head-of-line), so this is NOT a batch advance and does NOT self-exclude.
   *
   * I10 — F4: MONOTONIC (`MAX`) — never moves a persisted cursor backward. Forbids a stale/racing
   * writer regressing the position and hardens R1's persist-then-advance after a transient fault.
   * Writes `delivery_cursor` only; the pull cursor (last_read_message_id) is untouched.
   */
  set(agentId: string, channelId: number, messageId: number): void {
    const doSet = this.db.transaction(() => {
      this.db.run(
        `INSERT INTO cursors (agent_id, channel_id, delivery_cursor)
         VALUES (?, ?, ?)
         ON CONFLICT(agent_id, channel_id)
         DO UPDATE SET delivery_cursor = MAX(delivery_cursor, excluded.delivery_cursor)`,
        [agentId, channelId, messageId]
      );
    });
    withRetrySync(() => doSet.immediate());
  }

  listForAgent(agentId: string): CursorWithChannel[] {
    // I2 — Gap#2: membership-driving read (powers readAllUnread's pull-drain), so it
    // filters subscribed=1 — an unsubscribed channel must not auto-drain (pull-side ghost).
    return this.db
      .query(
        `SELECT cr.channel_id as channelId, ch.name as channelName,
                cr.last_read_message_id as lastReadMessageId
         FROM cursors cr
         JOIN channels ch ON cr.channel_id = ch.id
         WHERE cr.agent_id = ? AND cr.subscribed = 1`
      )
      .all(agentId) as CursorWithChannel[];
  }
}
