import type { Database } from "bun:sqlite";
import type { AdminModulePort } from "../../core/ports";
import type { AdminModuleDescription } from "../../core/admin/types";
import type { Channel } from "../../core/messaging/types";
import {
  AGENT_NAME_RE,
  validateAgentName,
  validateChannelName,
  validateMessageContent,
  extractMentions,
  assertDmAccess,
  isDmChannel,
  dmChannelName,
  isAgentActive,
} from "../../core/utils";
import { withRetrySync } from "./db";
import { insertMessageRow } from "./message-repo";
import { STORAGE_TYPEHEAD } from "./admin-typehead";

// The storage module of the admin API. Submitted code sees this as the
// `storage` global; raw SQL never crosses the boundary — every method is a
// controlled, parameterized operation that upholds the messaging invariants
// (FKs, mention extraction, membership-on-send, DM privacy).

export interface AgentRecord {
  id: string;
  created_at: number;
  last_seen_at: number;
  active: boolean;
}

// Same shape as the core domain type; aliased so the public API name is
// stable if either side ever gains a field the other doesn't want.
export type ChannelRecord = Channel;

export interface MemberRecord {
  agent_id: string;
  active: boolean;
}

export interface MessageRecord {
  id: number;
  channel: string;
  sender: string;
  content: string;
  created_at: number;
  mentions: string[];
}

export interface MessageFilter {
  channel?: string;
  sender?: string;
  // Messages that mention this agent (or everyone).
  mentioning?: string;
  // Only messages newer than this id.
  after_id?: number;
  since_ms?: number;
  until_ms?: number;
  // Default 100, max 10_000.
  limit?: number;
}

export interface CountFilter {
  channel?: string;
  since_ms?: number;
  until_ms?: number;
  group_by?: "sender" | "channel" | "day";
}

export interface CountRecord {
  // The sender, channel, or day counted; null when group_by was omitted.
  value: string | null;
  count: number;
}

export interface SendMessageInput {
  channel: string;
  sender: string;
  content: string;
  // Who to notify ("*" = everyone). Omitted → read from the content's @names.
  mentions?: string[];
}

export interface StorageApi {
  // Reading
  listAgents(): AgentRecord[];
  getAgent(id: string): AgentRecord | null;
  listChannels(): ChannelRecord[];
  getChannel(name: string): ChannelRecord | null;
  listMembers(channel: string): MemberRecord[];
  getMessages(filter?: MessageFilter): MessageRecord[];
  countMessages(filter?: CountFilter): CountRecord[];
  getLatestMessageId(): number;
  // Writing
  createAgentIfMissing(id: string): AgentRecord;
  createChannelIfMissing(name: string, createdBy: string): ChannelRecord;
  addMember(channel: string, agentId: string): void;
  sendMessage(input: SendMessageInput): MessageRecord;
  sendDirectMessage(input: { from: string; to: string; content: string }): MessageRecord;
}

const MAX_MESSAGE_LIMIT = 10_000;
const DEFAULT_MESSAGE_LIMIT = 100;

// Filter key → SQL predicate. Both read paths draw from this one table, so a
// predicate can never exist on one and be silently missing from the other.
// Each caller passes the keys it honors; the emitted SQL string set stays
// fixed and small, so db.query()'s prepared-statement cache still applies.
const FILTER_CLAUSES = {
  channel: "c.name = ?",
  sender: "m.agent_id = ?",
  mentioning:
    "EXISTS (SELECT 1 FROM json_each(m.mentions) WHERE json_each.value IN (?, '*'))",
  after_id: "m.id > ?",
  since_ms: "m.created_at >= ?",
  until_ms: "m.created_at <= ?",
} as const;

type FilterKey = keyof typeof FILTER_CLAUSES;

const MESSAGE_KEYS = [
  "channel",
  "sender",
  "mentioning",
  "after_id",
  "since_ms",
  "until_ms",
] as const satisfies readonly FilterKey[];
const COUNT_KEYS = ["channel", "since_ms", "until_ms"] as const satisfies readonly FilterKey[];

const GROUP_EXPRS = {
  sender: "m.agent_id",
  channel: "c.name",
  day: "strftime('%Y-%m-%d', m.created_at / 1000, 'unixepoch')",
} as const;

const MESSAGES_FROM = "FROM messages m JOIN channels c ON c.id = m.channel_id";

type AgentRow = {
  id: string;
  created_at: number;
  last_seen_at: number;
  pid: number | null;
};

export class SqliteAdminModule implements AdminModulePort {
  constructor(private readonly db: Database) {}

  describe(): AdminModuleDescription {
    return { globalName: "storage", provider: "sqlite", typehead: STORAGE_TYPEHEAD };
  }

  // Bound method references rather than arrow wrappers: TypeScript then checks
  // each full signature against the interface, so a parameter added to a
  // method can't be silently dropped here. The explicit enumeration is what
  // keeps internals (raw db access, private helpers) off the surface.
  createApi(): StorageApi {
    return {
      listAgents: this.listAgents.bind(this),
      getAgent: this.getAgent.bind(this),
      listChannels: this.listChannels.bind(this),
      getChannel: this.getChannel.bind(this),
      listMembers: this.listMembers.bind(this),
      getMessages: this.getMessages.bind(this),
      countMessages: this.countMessages.bind(this),
      getLatestMessageId: this.getLatestMessageId.bind(this),
      createAgentIfMissing: this.createAgentIfMissing.bind(this),
      createChannelIfMissing: this.createChannelIfMissing.bind(this),
      addMember: this.addMember.bind(this),
      sendMessage: this.sendMessage.bind(this),
      sendDirectMessage: this.sendDirectMessage.bind(this),
    };
  }

  // --- Read surface ---

  private listAgents(): AgentRecord[] {
    const rows = this.db
      .query("SELECT id, created_at, last_seen_at, pid FROM agents ORDER BY id")
      .all() as AgentRow[];
    return rows.map(toAgentRecord);
  }

  private getAgent(id: string): AgentRecord | null {
    const row = this.db
      .query("SELECT id, created_at, last_seen_at, pid FROM agents WHERE id = ?")
      .get(id) as AgentRow | null;
    return row ? toAgentRecord(row) : null;
  }

  private listChannels(): ChannelRecord[] {
    return this.db
      .query("SELECT id, name, created_by, created_at FROM channels ORDER BY id")
      .all() as ChannelRecord[];
  }

  private getChannel(name: string): ChannelRecord | null {
    return this.db
      .query("SELECT id, name, created_by, created_at FROM channels WHERE name = ?")
      .get(name) as ChannelRecord | null;
  }

  private listMembers(channel: string): MemberRecord[] {
    const ch = this.requireChannel(channel);
    const rows = this.db
      .query(
        `SELECT c.agent_id, a.pid, a.last_seen_at
         FROM cursors c JOIN agents a ON a.id = c.agent_id
         WHERE c.channel_id = ? ORDER BY c.agent_id`
      )
      .all(ch.id) as { agent_id: string; pid: number | null; last_seen_at: number }[];
    return rows.map((r) => ({ agent_id: r.agent_id, active: isAgentActive(r) }));
  }

  private getMessages(filter: MessageFilter = {}): MessageRecord[] {
    const { sql: whereSql, params } = buildWhere(filter, MESSAGE_KEYS);
    const limit = Math.max(
      1,
      Math.min(filter.limit ?? DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT)
    );
    const rows = this.db
      .query(
        `SELECT m.id, c.name AS channel, m.agent_id AS sender, m.content, m.created_at, m.mentions
         ${MESSAGES_FROM}${whereSql} ORDER BY m.id ASC LIMIT ?`
      )
      .all(...params, limit) as (Omit<MessageRecord, "mentions"> & { mentions: string })[];
    return rows.map((r) => ({ ...r, mentions: JSON.parse(r.mentions) as string[] }));
  }

  private countMessages(filter: CountFilter = {}): CountRecord[] {
    const { sql: whereSql, params } = buildWhere(filter, COUNT_KEYS);
    if (filter.group_by === undefined) {
      const row = this.db
        .query(`SELECT COUNT(*) AS count ${MESSAGES_FROM}${whereSql}`)
        .get(...params) as { count: number };
      return [{ value: null, count: row.count }];
    }
    const expr = GROUP_EXPRS[filter.group_by];
    return this.db
      .query(
        `SELECT ${expr} AS value, COUNT(*) AS count ${MESSAGES_FROM}${whereSql}
         GROUP BY ${expr} ORDER BY count DESC, value ASC`
      )
      .all(...params) as CountRecord[];
  }

  private getLatestMessageId(): number {
    const row = this.db
      .query("SELECT COALESCE(MAX(id), 0) AS max_id FROM messages")
      .get() as { max_id: number };
    return row.max_id;
  }

  // --- Write surface ---

  private createAgentIfMissing(id: string): AgentRecord {
    validateAgentName(id);
    // Common case is an integration re-registering itself every event: a WAL
    // read costs nothing, while the insert path takes the DB-wide write lock.
    const existing = this.getAgent(id);
    if (existing) return existing;
    const doCreate = this.db.transaction(() => {
      this.insertAgentIfMissing(id);
      return this.getAgent(id)!;
    });
    return withRetrySync(() => doCreate.immediate());
  }

  private createChannelIfMissing(name: string, createdBy: string): ChannelRecord {
    validateChannelName(name);
    if (isDmChannel(name)) {
      throw new Error(
        `"${name}" is a DM-style name; use sendDirectMessage for direct messages`
      );
    }
    validateAgentName(createdBy);
    const doCreate = this.db.transaction(() => {
      this.insertAgentIfMissing(createdBy);
      const channel = this.insertChannelIfMissing(name, createdBy);
      // The channel's actual creator joins, mirroring messaging_create_channel.
      // On an existing channel that is the original creator, not this caller —
      // so a repeat call doesn't silently subscribe a bystander.
      this.insertMemberIfMissing(channel.created_by, channel.id);
      return channel;
    });
    return withRetrySync(() => doCreate.immediate());
  }

  private addMember(channel: string, agentId: string): void {
    validateAgentName(agentId);
    assertDmAccess(channel, agentId);
    const doAdd = this.db.transaction(() => {
      const ch = this.requireChannel(channel);
      this.insertAgentIfMissing(agentId);
      this.insertMemberIfMissing(agentId, ch.id);
    });
    withRetrySync(() => doAdd.immediate());
  }

  // Inserting the row IS the delivery: every agent's server process watches
  // the messages table and pushes rows whose mentions match its agent.
  private sendMessage(input: SendMessageInput): MessageRecord {
    const { channel, sender, content } = input;
    validateMessageContent(content);
    assertDmAccess(channel, sender);
    if (sender !== "_system") validateAgentName(sender);

    // Resolved before the transaction opens: reads are free in WAL, and the
    // write lock serializes every process on the shared database, so no query
    // that can run outside belongs inside. Mirrors MessagingService.send,
    // which reads the agent list before entering the insert transaction.
    const mentions =
      input.mentions !== undefined
        ? validateMentions(input.mentions)
        : extractMentions(content, this.allAgentIds());
    if (mentions.includes(sender)) {
      throw new Error("Cannot @mention yourself in a message");
    }

    const doSend = this.db.transaction(() => {
      const ch = this.requireChannel(channel);
      if (sender !== "_system") this.insertAgentIfMissing(sender);
      return this.insertMessage(ch, sender, content, mentions);
    });
    return withRetrySync(() => doSend.immediate());
  }

  private sendDirectMessage(input: { from: string; to: string; content: string }): MessageRecord {
    const { from, to, content } = input;
    validateAgentName(from);
    validateAgentName(to);
    if (from === to) throw new Error("Cannot DM yourself");
    validateMessageContent(content);
    const doSend = this.db.transaction(() => {
      // The target must already exist — a DM to an agent nobody has ever
      // registered would never be received.
      if (this.getAgent(to) === null) throw new Error(`Agent "${to}" not found`);
      this.insertAgentIfMissing(from);
      const channel = this.insertChannelIfMissing(dmChannelName(from, to), from);
      this.insertMemberIfMissing(from, channel.id);
      this.insertMemberIfMissing(to, channel.id);
      // DM channels push every message regardless of mentions.
      return this.insertMessage(channel, from, content, []);
    });
    return withRetrySync(() => doSend.immediate());
  }

  // --- Internals (all called inside a transaction where it matters) ---

  private requireChannel(name: string): ChannelRecord {
    const channel = this.getChannel(name);
    if (!channel) throw new Error(`Channel "${name}" does not exist`);
    return channel;
  }

  private allAgentIds(): string[] {
    const rows = this.db.query("SELECT id FROM agents").all() as { id: string }[];
    return rows.map((r) => r.id);
  }

  private insertAgentIfMissing(id: string): void {
    const now = Date.now();
    this.db
      .query(
        "INSERT INTO agents (id, created_at, last_seen_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING"
      )
      .run(id, now, now);
  }

  private insertChannelIfMissing(name: string, createdBy: string): ChannelRecord {
    this.db
      .query(
        "INSERT INTO channels (name, created_by, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING"
      )
      .run(name, createdBy, Date.now());
    return this.getChannel(name)!;
  }

  private insertMemberIfMissing(agentId: string, channelId: number): void {
    this.db
      .query(
        `INSERT INTO cursors (agent_id, channel_id, last_read_message_id)
         VALUES (?, ?, 0) ON CONFLICT(agent_id, channel_id) DO NOTHING`
      )
      .run(agentId, channelId);
  }

  // Delegates to the shared insertMessageRow (see message-repo.ts) — callers
  // here already hold an open .immediate() write transaction, so the shared
  // body adds no transaction or retry of its own.
  private insertMessage(
    channel: ChannelRecord,
    sender: string,
    content: string,
    mentions: string[]
  ): MessageRecord {
    const msg = insertMessageRow(this.db, channel.id, sender, content, mentions);
    return {
      id: msg.id,
      channel: channel.name,
      sender,
      content,
      created_at: msg.created_at,
      mentions,
    };
  }
}

function buildWhere(
  filter: Partial<Record<FilterKey, unknown>>,
  keys: readonly FilterKey[]
): { sql: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  for (const key of keys) {
    const value = filter[key];
    if (value === undefined) continue;
    clauses.push(FILTER_CLAUSES[key]);
    params.push(value as string | number);
  }
  return {
    sql: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function toAgentRecord(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    active: isAgentActive(row),
  };
}

function validateMentions(mentions: string[]): string[] {
  for (const name of mentions) {
    if (name !== "*" && !AGENT_NAME_RE.test(name)) {
      throw new Error(`invalid mention "${name}" (use agent names or "*" for everyone)`);
    }
  }
  return mentions;
}
