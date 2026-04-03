import type { Database } from "bun:sqlite";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Message } from "./modules/messaging/types";
import { PID_STALE_MS, isProcessAlive } from "./modules/messaging/tools";
import { log } from "./bootstrap";

export type NotifyFn = (content: string, meta: Record<string, string>) => Promise<void>;

export function startPolling(
  db: Database,
  agentId: string,
  notify: NotifyFn,
  intervalMs: number = 3000
): () => Promise<void> {
  // Separate from DB cursors: tracks pushed (not acknowledged) messages.
  // hwm = max(cursor, lastPushedId) — avoids re-push without advancing cursor.
  // Resets on process restart; duplicates are acceptable, lost messages are not.
  const lastPushedId = new Map<number, number>();
  let active = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tickPromise: Promise<void> | null = null;

  const stmtSubscribed = db.query(
    `SELECT cr.channel_id, ch.name as channel_name
     FROM cursors cr
     JOIN channels ch ON cr.channel_id = ch.id
     WHERE cr.agent_id = ?`
  );
  // Re-read per-channel cursor inside the loop — cursor may advance during an
  // in-flight notify (e.g. agent reads a channel while another notify is awaited)
  const stmtCursor = db.query(
    "SELECT last_read_message_id FROM cursors WHERE agent_id = ? AND channel_id = ?"
  );
  const stmtStats = db.query(
    `SELECT COUNT(*) as count, MAX(id) as max_id
     FROM messages
     WHERE channel_id = ? AND id > ? AND agent_id != ?`
  );
  const stmtLatest = db.query("SELECT id, agent_id, content, mentions FROM messages WHERE id = ?");
  const stmtMemberCount = db.query(
    `SELECT COUNT(*) as count FROM cursors cr
     JOIN agents a ON cr.agent_id = a.id
     WHERE cr.channel_id = ? AND a.pid IS NOT NULL AND a.last_seen_at > ?`
  );
  const stmtBatchMentions = db.query(
    `SELECT mentions FROM messages
     WHERE channel_id = ? AND id > ? AND id <= ? AND agent_id != ?`
  );
  const stmtHeartbeat = db.query(
    "UPDATE agents SET last_seen_at = ? WHERE id = ? AND pid = ?"
  );

  async function tick() {
    log(`tick ${agentId}`);
    // Heartbeat: keep agent's last_seen_at fresh while polling.
    // Prevents PID staleness reclaim of actively-listening agents.
    // If the heartbeat matches 0 rows and the agent has a different PID,
    // another process has reclaimed our agent name — stop polling to avoid
    // delivering notifications to a stale session. A null-PID agent (REPL
    // or test-only path) is expected to have 0-change heartbeats and should
    // continue polling.
    const heartbeat = stmtHeartbeat.run(Date.now(), agentId, process.pid);
    if (heartbeat.changes === 0) {
      const row = db.query("SELECT pid FROM agents WHERE id = ?").get(agentId) as { pid: number | null } | null;
      if (row && row.pid !== null && row.pid !== process.pid) {
        if (isProcessAlive(row.pid)) {
          active = false;
          return;
        }
        // Stale PID from crashed process — reclaim and continue polling.
        // CAS: if another process won the reclaim race, changes === 0 and we stop.
        const reclaim = db.query(
          "UPDATE agents SET pid = ?, last_seen_at = ? WHERE id = ? AND pid = ?"
        ).run(process.pid, Date.now(), agentId, row.pid);
        if (reclaim.changes === 0) {
          active = false;
          return;
        }
      }
    }

    const subscribedChannels = stmtSubscribed
      .all(agentId) as { channel_id: number; channel_name: string }[];
    log(`${agentId}: ${subscribedChannels.length} subscribed channel(s)`);

    const activeIds = new Set(subscribedChannels.map(s => s.channel_id));
    for (const k of lastPushedId.keys()) {
      if (!activeIds.has(k)) lastPushedId.delete(k);
    }

    for (const sub of subscribedChannels) {
      const cursor = stmtCursor
        .get(agentId, sub.channel_id) as { last_read_message_id: number } | null;

      if (!cursor) continue;

      if (!lastPushedId.has(sub.channel_id)) {
        lastPushedId.set(sub.channel_id, cursor.last_read_message_id);
      }

      const hwm = Math.max(
        cursor.last_read_message_id,
        lastPushedId.get(sub.channel_id)!
      );

      const stats = stmtStats
        .get(sub.channel_id, hwm, agentId) as { count: number; max_id: number | null };

      if (stats.count === 0 || stats.max_id === null) continue;
      log(`${agentId} on ${sub.channel_name}: ${stats.count} unread, hwm=${hwm}, max_id=${stats.max_id}, memberCount=${(stmtMemberCount.get(sub.channel_id, Date.now() - PID_STALE_MS) as { count: number }).count}`);

      // Check channel mode: DM (2 members) vs. group (3+)
      const freshThreshold = Date.now() - PID_STALE_MS;
      const memberCount = (stmtMemberCount.get(sub.channel_id, freshThreshold) as { count: number }).count;

      if (memberCount > 2) {
        // Group mode — check if ANY message in the batch targets this agent
        const batchMentions = stmtBatchMentions
          .all(sub.channel_id, hwm, stats.max_id, agentId) as { mentions: string }[];

        let shouldNotify = false;
        for (const row of batchMentions) {
          const mentions: string[] = JSON.parse(row.mentions);
          if (mentions.includes("*") || mentions.includes(agentId)) {
            shouldNotify = true;
            break;
          }
        }
        if (!shouldNotify) continue;
      }
      // DM mode (2 members) or passed group filter — proceed to notify

      const latest = stmtLatest.get(stats.max_id) as {
        id: number; agent_id: string; content: string; mentions: string;
      };

      const content =
        stats.count === 1
          ? latest.content
          : `${stats.count} new messages on ${sub.channel_name}. Latest: ${latest.content}`;

      const meta = {
        channel_name: sub.channel_name,
        sender: latest.agent_id,
        message_id: String(latest.id),
      };

      try {
        log(`notifying ${agentId} on ${sub.channel_name}: "${content.slice(0, 80)}"`);
        await notify(content, meta);
        log(`notify OK for ${agentId}, lastPushedId → ${latest.id}`);
        lastPushedId.set(sub.channel_id, latest.id);
      } catch (err) {
        log(`notify FAILED for ${agentId}: ${err}`);
      }
    }
  }

  function scheduleNext() {
    if (!active) return;
    timer = setTimeout(() => {
      tickPromise = (async () => {
        try {
          await tick();
        } catch (err) {
          log(`channel poll error: ${err}`);
        }
        tickPromise = null;
        scheduleNext();
      })();
    }, intervalMs);
    timer.unref();
  }

  scheduleNext();

  return async () => {
    active = false;
    if (timer !== null) clearTimeout(timer);
    if (tickPromise !== null) await tickPromise;
  };
}

export function sendChannelNotification(
  server: Server,
  content: string,
  meta: Record<string, string>
): Promise<void> {
  return server.notification({
    method: "notifications/claude/channel",
    params: { content, meta },
  });
}
