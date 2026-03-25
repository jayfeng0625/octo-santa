import type { Database } from "bun:sqlite";
import type { Migration } from "../../migrations";
import { withRetrySync } from "../../db";
import type { Agent, Channel, Message } from "./types";

const AGENT_NAME_RE = /^[\w-]+$/;
const RESERVED_AGENT_NAMES = new Set(["all", "here"]);

export function validateAgentName(agentId: string): void {
  if (!agentId.trim()) throw new Error("agent_id must not be empty");
  if (!AGENT_NAME_RE.test(agentId))
    throw new Error(
      `agent_id must match [\\w-]+ (letters, digits, underscores, hyphens), got "${agentId}"`
    );
  if (RESERVED_AGENT_NAMES.has(agentId))
    throw new Error(`agent_id "${agentId}" is reserved for broadcast mentions`);
}

const MENTION_RE = /@([\w-]+)/g;

export function extractMentions(content: string, validAgentIds: string[]): string[] {
  const matches = content.matchAll(MENTION_RE);
  const validSet = new Set(validAgentIds);
  const result = new Set<string>();
  let hasBroadcast = false;

  for (const match of matches) {
    const name = match[1]!;
    if (name === "all" || name === "here") {
      hasBroadcast = true;
    } else if (validSet.has(name)) {
      result.add(name);
    }
  }

  if (hasBroadcast) return ["*"];
  return [...result];
}

export function getCursor(
  db: Database,
  agentId: string,
  channelId: number
): number {
  const row = db
    .query("SELECT last_read_message_id FROM cursors WHERE agent_id = ? AND channel_id = ?")
    .get(agentId, channelId) as { last_read_message_id: number } | null;
  return row?.last_read_message_id ?? 0;
}

export const messagingMigrations: Migration[] = [
  {
    name: "messaging_001_initial_schema",
    up: `
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        created_by TEXT NOT NULL REFERENCES agents(id),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER NOT NULL REFERENCES channels(id),
        agent_id TEXT NOT NULL REFERENCES agents(id),
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_messages_channel_id ON messages(channel_id, id, agent_id);
      CREATE TABLE cursors (
        agent_id TEXT NOT NULL REFERENCES agents(id),
        channel_id INTEGER NOT NULL REFERENCES channels(id),
        last_read_message_id INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, channel_id)
      );
    `,
  },
  {
    name: "messaging_002_mentions_and_pid",
    up: `
      ALTER TABLE agents ADD COLUMN pid INTEGER;
      ALTER TABLE agents ADD COLUMN registered_at INTEGER;
      ALTER TABLE messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]';
    `,
  },
];

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "EPERM") return true; // exists, not signalable
    return false; // ESRCH = no such process
  }
}

// Staleness threshold for PID reuse detection (15 minutes).
// Primary cleanup is onclose unregister; this is only a crash-recovery backstop.
export const PID_STALE_MS = 15 * 60 * 1000;

/** Exact liveness check: PID set + process alive + last_seen_at fresh.
 *  Used by listAgents(active_only), listChannelMembers, registerAgent.
 *  For the polling hot path (DM/group mode), use SQL-only approximate liveness instead. */
export function isAgentActive(agent: Agent): boolean {
  if (agent.pid === null) return false;
  if (!isProcessAlive(agent.pid)) return false;
  return Date.now() - agent.last_seen_at <= PID_STALE_MS;
}

export function registerAgent(db: Database, agentId: string): Agent {
  validateAgentName(agentId);

  const doRegister = db.transaction(() => {
    const now = Date.now();
    const existing = getAgent(db, agentId);

    if (existing && existing.pid !== null && existing.pid !== process.pid) {
      if (isAgentActive(existing)) {
        throw new Error(
          `Agent "${agentId}" is already active (pid ${existing.pid}). Choose a different name.`
        );
      }
    }

    db.run(
      `INSERT INTO agents (id, created_at, last_seen_at, pid, registered_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at, pid = excluded.pid, registered_at = excluded.registered_at`,
      [agentId, now, now, process.pid, now]
    );

    return getAgent(db, agentId)!;
  });

  return withRetrySync(() => doRegister.exclusive());
}

/** Internal lifecycle function — called by mcp.ts onclose, NOT exposed as MCP tool.
 *  Ownership-scoped via WHERE clause: only clears PID if it still matches expectedPid,
 *  preventing late-onclose from clobbering a new session's registration.
 *  Single atomic UPDATE — no read-then-write race. */
export function unregisterAgent(db: Database, agentId: string, expectedPid: number): void {
  withRetrySync(() => {
    db.run(
      "UPDATE agents SET pid = NULL, registered_at = NULL WHERE id = ? AND pid = ?",
      [agentId, expectedPid]
    );
  });
}

export function getAgent(db: Database, agentId: string): Agent | null {
  return (db.query("SELECT * FROM agents WHERE id = ?").get(agentId) as Agent) ?? null;
}

/** Lightweight agent upsert — no PID check, no exclusive lock.
 *  Used by createChannel/readMessages where we just need the agent row to exist. */
function ensureAgent(db: Database, agentId: string): void {
  validateAgentName(agentId);
  withRetrySync(() => {
    const now = Date.now();
    db.run(
      `INSERT INTO agents (id, created_at, last_seen_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      [agentId, now, now]
    );
  });
}

export function listAgents(db: Database): Agent[] {
  return db.query("SELECT * FROM agents ORDER BY id").all() as Agent[];
}

export function createChannel(db: Database, name: string, agentId: string): Channel {
  if (!name.trim()) throw new Error("channel name must not be empty");
  ensureAgent(db, agentId);

  return withRetrySync(() => {
    db.run(
      `INSERT INTO channels (name, created_by, created_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO NOTHING`,
      [name, agentId, Date.now()]
    );

    return db.query("SELECT * FROM channels WHERE name = ?").get(name) as Channel;
  });
}

export function listChannels(db: Database): Channel[] {
  return db.query("SELECT * FROM channels ORDER BY name").all() as Channel[];
}

export interface ReadOptions {
  limit?: number;
  before_id?: number;
}

export function readMessages(
  db: Database,
  agentId: string,
  channelName: string,
  options?: ReadOptions
): Message[] {
  ensureAgent(db, agentId);

  const channel = db.query("SELECT id FROM channels WHERE name = ?").get(channelName) as { id: number } | null;
  if (!channel) return [];

  // History mode — do NOT advance cursor
  if (options?.before_id !== undefined) {
    const limit = options.limit ?? 50;
    const rows = db
      .query(
        `SELECT * FROM messages
         WHERE channel_id = ? AND id < ? AND agent_id != ?
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(channel.id, options.before_id, agentId, limit) as Message[];
    return rows.reverse(); // Return in chronological order
  }

  // Forward mode — advance cursor atomically
  const doRead = db.transaction(() => {
    const lastReadId = getCursor(db, agentId, channel.id);
    const limit = options?.limit ?? 100;

    const messages = db
      .query(
        `SELECT * FROM messages
         WHERE channel_id = ? AND id > ? AND agent_id != ?
         ORDER BY id ASC
         LIMIT ?`
      )
      .all(channel.id, lastReadId, agentId, limit) as Message[];

    const cursorValue = messages.length > 0 ? messages[messages.length - 1]!.id : lastReadId;
    db.run(
      `INSERT INTO cursors (agent_id, channel_id, last_read_message_id)
       VALUES (?, ?, ?)
       ON CONFLICT(agent_id, channel_id)
       DO UPDATE SET last_read_message_id = excluded.last_read_message_id`,
      [agentId, channel.id, cursorValue]
    );

    return messages;
  });

  return withRetrySync(() => doRead());
}

/**
 * Subscribe to a channel's poll without consuming unread messages.
 * Creates cursor at the current max message ID if none exists.
 * Leaves existing cursor untouched — preserves unread backlog.
 */
export function subscribeToChannel(
  db: Database,
  agentId: string,
  channelName: string
): void {
  const channel = createChannel(db, channelName, agentId);

  withRetrySync(() => {
    // Get the current max message ID for this channel
    const maxRow = db
      .query("SELECT MAX(id) as max_id FROM messages WHERE channel_id = ?")
      .get(channel.id) as { max_id: number | null };
    const maxId = maxRow?.max_id ?? 0;

    // Only create cursor if none exists — ON CONFLICT DO NOTHING preserves existing
    db.run(
      `INSERT INTO cursors (agent_id, channel_id, last_read_message_id)
       VALUES (?, ?, ?)
       ON CONFLICT(agent_id, channel_id) DO NOTHING`,
      [agentId, channel.id, maxId]
    );
  });
}

export function sendMessage(
  db: Database,
  agentId: string,
  channelName: string,
  content: string
): Message {
  if (!content.trim()) throw new Error("message content must not be empty");
  const channel = createChannel(db, channelName, agentId);

  const doSend = db.transaction(() => {
    const now = Date.now();

    // Extract valid agent IDs for mention validation
    const allAgents = db.query("SELECT id FROM agents").all() as { id: string }[];
    const validIds = allAgents.map((a) => a.id);
    const mentions = JSON.stringify(extractMentions(content, validIds));

    db.run(
      "INSERT INTO messages (channel_id, agent_id, content, created_at, mentions) VALUES (?, ?, ?, ?, ?)",
      [channel.id, agentId, content, now, mentions]
    );
    const lastId = db.query("SELECT last_insert_rowid() as id").get() as { id: number };

    // Upsert cursor for sender — ensures sender counts as a channel member
    // for DM/group mode detection. Uses 0 as initial value so the sender
    // doesn't skip unread messages from others. On conflict, keeps the
    // existing cursor value (a prior readMessages may have advanced it).
    db.run(
      `INSERT INTO cursors (agent_id, channel_id, last_read_message_id)
       VALUES (?, ?, 0)
       ON CONFLICT(agent_id, channel_id) DO NOTHING`,
      [agentId, channel.id]
    );

    return {
      id: lastId.id,
      channel_id: channel.id,
      agent_id: agentId,
      content,
      created_at: now,
      mentions,
    };
  });

  return withRetrySync(() => doSend());
}
