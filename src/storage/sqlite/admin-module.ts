import type { Database } from "bun:sqlite";
import type { AdminModulePort } from "../../core/ports";
import type { AdminModuleDescription } from "../../core/admin/types";
import {
  validateAgentName,
  extractMentions,
  assertDmAccess,
  isDmChannel,
  dmChannelName,
  isAgentActive,
} from "../../core/utils";
import { withRetrySync } from "./db";
import { STORAGE_TYPEHEAD } from "./admin-typehead";

// The storage module of the code-mode admin plane. Submitted TypeScript sees
// this API as the `storage` global; raw SQL never crosses the boundary — every
// method is a controlled, parameterized operation that upholds the messaging
// invariants (FKs, mention extraction, membership-on-send, DM privacy).
//
// All SQL strings here come from a small fixed set, so db.query()'s prepared-
// statement cache applies throughout.

export interface AgentRecord {
  id: string;
  created_at: number;
  last_seen_at: number;
  active: boolean;
}

export interface ChannelRecord {
  id: number;
  name: string;
  created_by: string;
  created_at: number;
}

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
  // Messages that mention this agent (or @all).
  mentioning?: string;
  // Cursor for incremental pulls: only messages with id > afterId.
  afterId?: number;
  sinceMs?: number;
  untilMs?: number;
  // Default 100, max 10_000.
  limit?: number;
}

export interface CountFilter {
  channel?: string;
  sinceMs?: number;
  untilMs?: number;
  groupBy?: "sender" | "channel" | "day";
}

export interface CountRecord {
  group: string | null;
  count: number;
}

export interface PostMessageInput {
  channel: string;
  sender: string;
  content: string;
  // Explicit mention targets ("*" = @all). Omitted → extracted from content.
  mentions?: string[];
}

export interface StorageSearchApi {
  listAgents(): AgentRecord[];
  getAgent(id: string): AgentRecord | null;
  listChannels(): ChannelRecord[];
  getChannel(name: string): ChannelRecord | null;
  listMembers(channel: string): MemberRecord[];
  getMessages(filter?: MessageFilter): MessageRecord[];
  countMessages(filter?: CountFilter): CountRecord[];
  getMaxMessageId(): number;
}

export interface StorageExecuteApi extends StorageSearchApi {
  ensureAgent(id: string): AgentRecord;
  ensureChannel(name: string, createdBy: string): ChannelRecord;
  addMember(channel: string, agentId: string): void;
  postMessage(input: PostMessageInput): MessageRecord;
  postDirectMessage(input: { from: string; to: string; content: string }): MessageRecord;
}

const CHANNEL_NAME_RE = /^[\w.,@#-]+$/;
const MENTION_NAME_RE = /^[\w-]+$/;
const MAX_CONTENT_LENGTH = 100_000;
const MAX_MESSAGE_LIMIT = 10_000;
const DEFAULT_MESSAGE_LIMIT = 100;

const GROUP_EXPRS: Record<NonNullable<CountFilter["groupBy"]>, string> = {
  sender: "m.agent_id",
  channel: "c.name",
  day: "strftime('%Y-%m-%d', m.created_at / 1000, 'unixepoch')",
};

export class SqliteAdminModule implements AdminModulePort {
  constructor(private readonly db: Database) {}

  describe(): AdminModuleDescription {
    return { module: "storage", provider: "sqlite", typehead: STORAGE_TYPEHEAD };
  }

  createSearchApi(): StorageSearchApi {
    return {
      listAgents: () => this.listAgents(),
      getAgent: (id) => this.getAgent(id),
      listChannels: () => this.listChannels(),
      getChannel: (name) => this.getChannel(name),
      listMembers: (channel) => this.listMembers(channel),
      getMessages: (filter) => this.getMessages(filter),
      countMessages: (filter) => this.countMessages(filter),
      getMaxMessageId: () => this.getMaxMessageId(),
    };
  }

  createExecuteApi(): StorageExecuteApi {
    return {
      ...this.createSearchApi(),
      ensureAgent: (id) => this.ensureAgent(id),
      ensureChannel: (name, createdBy) => this.ensureChannel(name, createdBy),
      addMember: (channel, agentId) => this.addMember(channel, agentId),
      postMessage: (input) => this.postMessage(input),
      postDirectMessage: (input) => this.postDirectMessage(input),
    };
  }

  // --- Read surface ---

  private listAgents(): AgentRecord[] {
    const rows = this.db
      .query("SELECT id, created_at, last_seen_at, pid FROM agents ORDER BY id")
      .all() as { id: string; created_at: number; last_seen_at: number; pid: number | null }[];
    return rows.map(toAgentRecord);
  }

  private getAgent(id: string): AgentRecord | null {
    const row = this.db
      .query("SELECT id, created_at, last_seen_at, pid FROM agents WHERE id = ?")
      .get(id) as { id: string; created_at: number; last_seen_at: number; pid: number | null } | null;
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
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.channel !== undefined) {
      where.push("c.name = ?");
      params.push(filter.channel);
    }
    if (filter.sender !== undefined) {
      where.push("m.agent_id = ?");
      params.push(filter.sender);
    }
    if (filter.mentioning !== undefined) {
      where.push(
        "EXISTS (SELECT 1 FROM json_each(m.mentions) WHERE json_each.value IN (?, '*'))"
      );
      params.push(filter.mentioning);
    }
    if (filter.afterId !== undefined) {
      where.push("m.id > ?");
      params.push(filter.afterId);
    }
    if (filter.sinceMs !== undefined) {
      where.push("m.created_at >= ?");
      params.push(filter.sinceMs);
    }
    if (filter.untilMs !== undefined) {
      where.push("m.created_at <= ?");
      params.push(filter.untilMs);
    }
    const limit = Math.max(
      1,
      Math.min(filter.limit ?? DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT)
    );
    const sql =
      "SELECT m.id, c.name AS channel, m.agent_id AS sender, m.content, m.created_at, m.mentions " +
      "FROM messages m JOIN channels c ON c.id = m.channel_id" +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY m.id ASC LIMIT ?";
    const rows = this.db.query(sql).all(...params, limit) as (Omit<
      MessageRecord,
      "mentions"
    > & { mentions: string })[];
    return rows.map((r) => ({ ...r, mentions: JSON.parse(r.mentions) as string[] }));
  }

  private countMessages(filter: CountFilter = {}): CountRecord[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.channel !== undefined) {
      where.push("c.name = ?");
      params.push(filter.channel);
    }
    if (filter.sinceMs !== undefined) {
      where.push("m.created_at >= ?");
      params.push(filter.sinceMs);
    }
    if (filter.untilMs !== undefined) {
      where.push("m.created_at <= ?");
      params.push(filter.untilMs);
    }
    const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    const from = "FROM messages m JOIN channels c ON c.id = m.channel_id";
    if (filter.groupBy === undefined) {
      const row = this.db
        .query(`SELECT COUNT(*) AS count ${from}${whereSql}`)
        .get(...params) as { count: number };
      return [{ group: null, count: row.count }];
    }
    const expr = GROUP_EXPRS[filter.groupBy];
    return this.db
      .query(
        `SELECT ${expr} AS "group", COUNT(*) AS count ${from}${whereSql} GROUP BY ${expr} ORDER BY count DESC, "group" ASC`
      )
      .all(...params) as CountRecord[];
  }

  private getMaxMessageId(): number {
    const row = this.db
      .query("SELECT COALESCE(MAX(id), 0) AS max_id FROM messages")
      .get() as { max_id: number };
    return row.max_id;
  }

  // --- Write surface ---

  private ensureAgent(id: string): AgentRecord {
    validateAgentName(id);
    const doEnsure = this.db.transaction(() => this.insertAgentIfMissing(id));
    withRetrySync(() => doEnsure.immediate());
    return this.getAgent(id)!;
  }

  private ensureChannel(name: string, createdBy: string): ChannelRecord {
    validateChannelName(name);
    if (isDmChannel(name)) {
      throw new Error(
        `"${name}" is a DM-style name; use postDirectMessage for direct messages`
      );
    }
    validateAgentName(createdBy);
    const doEnsure = this.db.transaction(() => {
      this.insertAgentIfMissing(createdBy);
      this.db
        .query(
          "INSERT INTO channels (name, created_by, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING"
        )
        .run(name, createdBy, Date.now());
      const channel = this.getChannel(name)!;
      // The channel's actual creator joins, mirroring
      // messaging_create_channel's auto-join. On an already-existing channel
      // that is the original creator, not this idempotent caller — so a
      // repeat ensureChannel with a different name doesn't silently subscribe
      // a bystander. Use addMember to join others explicitly.
      this.insertMemberIfMissing(channel.created_by, channel.id);
      return channel;
    });
    return withRetrySync(() => doEnsure.immediate());
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
  private postMessage(input: PostMessageInput): MessageRecord {
    const { channel, sender, content } = input;
    validateContent(content);
    assertDmAccess(channel, sender);
    const doPost = this.db.transaction(() => {
      const ch = this.requireChannel(channel);
      if (sender !== "_system") {
        validateAgentName(sender);
        this.insertAgentIfMissing(sender);
      }
      const mentions =
        input.mentions !== undefined
          ? validateMentions(input.mentions)
          : extractMentions(content, this.allAgentIds());
      if (mentions.includes(sender)) {
        throw new Error("Cannot @mention yourself in a message");
      }
      return this.insertMessage(ch, sender, content, mentions);
    });
    return withRetrySync(() => doPost.immediate());
  }

  private postDirectMessage(input: { from: string; to: string; content: string }): MessageRecord {
    const { from, to, content } = input;
    validateAgentName(from);
    validateAgentName(to);
    if (from === to) throw new Error("Cannot DM yourself");
    validateContent(content);
    const doPost = this.db.transaction(() => {
      // The target must already exist — a DM to an agent nobody has ever
      // registered would never be received.
      if (this.getAgent(to) === null) throw new Error(`Agent "${to}" not found`);
      this.insertAgentIfMissing(from);
      const name = dmChannelName(from, to);
      this.db
        .query(
          "INSERT INTO channels (name, created_by, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING"
        )
        .run(name, from, Date.now());
      const channel = this.getChannel(name)!;
      this.insertMemberIfMissing(from, channel.id);
      this.insertMemberIfMissing(to, channel.id);
      // DM channels push every message regardless of mentions.
      return this.insertMessage(channel, from, content, []);
    });
    return withRetrySync(() => doPost.immediate());
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

  private insertMemberIfMissing(agentId: string, channelId: number): void {
    this.db
      .query(
        `INSERT INTO cursors (agent_id, channel_id, last_read_message_id)
         VALUES (?, ?, 0) ON CONFLICT(agent_id, channel_id) DO NOTHING`
      )
      .run(agentId, channelId);
  }

  private insertMessage(
    channel: ChannelRecord,
    sender: string,
    content: string,
    mentions: string[]
  ): MessageRecord {
    const now = Date.now();
    const mentionsJson = JSON.stringify(mentions);
    this.db
      .query(
        "INSERT INTO messages (channel_id, agent_id, content, created_at, mentions) VALUES (?, ?, ?, ?, ?)"
      )
      .run(channel.id, sender, content, now, mentionsJson);
    const idRow = this.db.query("SELECT last_insert_rowid() AS id").get() as { id: number };
    // Sender joins on send, mirroring insertAndJoinSender.
    this.insertMemberIfMissing(sender, channel.id);
    return {
      id: idRow.id,
      channel: channel.name,
      sender,
      content,
      created_at: now,
      mentions,
    };
  }
}

function toAgentRecord(row: {
  id: string;
  created_at: number;
  last_seen_at: number;
  pid: number | null;
}): AgentRecord {
  return {
    id: row.id,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    active: isAgentActive(row),
  };
}

function validateChannelName(name: string): void {
  if (!name.trim()) throw new Error("channel name must not be empty");
  if (name.length > 128) throw new Error("channel name must not exceed 128 characters");
  if (!CHANNEL_NAME_RE.test(name)) {
    throw new Error(
      "channel name must contain only letters, digits, underscores, hyphens, dots, commas, @ or #"
    );
  }
}

function validateContent(content: string): void {
  if (!content.trim()) throw new Error("message content must not be empty");
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new Error(`message content must not exceed ${MAX_CONTENT_LENGTH} characters`);
  }
}

function validateMentions(mentions: string[]): string[] {
  for (const name of mentions) {
    if (name !== "*" && !MENTION_NAME_RE.test(name)) {
      throw new Error(`invalid mention "${name}" (use agent names or "*" for @all)`);
    }
  }
  return mentions;
}
