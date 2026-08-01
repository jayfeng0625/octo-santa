// The storage module's typehead: the TypeScript declaration fragment that
// tells approved external apps what the `storage` global can do inside code
// submitted to admin_search / admin_execute. Served (composed with core's
// execution-model header) as the `octo-santa://admin/typehead.d.ts` resource.
//
// Raw SQL is deliberately absent from this surface — the module exposes only
// controlled methods that uphold the messaging invariants. Keep this text in
// lockstep with the StorageSearchApi / StorageExecuteApi interfaces in
// admin-module.ts; the drift-guard test asserts every API method is declared
// here.

export const STORAGE_TYPEHEAD = `\
// ── Module "storage" (provider: sqlite) ─────────────────────────────────────
// Controlled access to octo-santa's shared database — the single SQLite file
// that is the only bridge between agent processes. There is no raw SQL here:
// use the typed methods below.
//
// DELIVERY MODEL: posting a message writes it to the shared database, and
// every agent's own server process watches that database (~2s) and pushes
// matching messages to its agent. So postMessage / postDirectMessage IS a
// push delivery — there is no other signal to send. Push targeting reads the
// mentions ("*" = @all; DM channels always push); unmentioned channel
// messages are silent until the recipient reads.

/** An agent known to the system. External apps appear here too once ensured. */
interface AgentRecord {
  id: string;
  /** Unix ms of first registration. */
  created_at: number;
  /** Unix ms of last heartbeat. */
  last_seen_at: number;
  /** True when the agent's process is currently alive and heartbeating. */
  active: boolean;
}

/** A channel. DM channels are named "<a>,<b>" (participants sorted). */
interface ChannelRecord {
  id: number;
  name: string;
  created_by: string;
  created_at: number;
}

interface MemberRecord {
  agent_id: string;
  active: boolean;
}

interface MessageRecord {
  /** Monotonic — usable as a cursor (see getMessages afterId). */
  id: number;
  /** Channel name. */
  channel: string;
  /** Sending agent id. */
  sender: string;
  content: string;
  /** Unix ms. */
  created_at: number;
  /** Mentioned agent names; ["*"] = @all; [] = silent. */
  mentions: string[];
}

interface MessageFilter {
  channel?: string;
  sender?: string;
  /** Messages that mention this agent (includes @all broadcasts). */
  mentioning?: string;
  /** Only messages with id > afterId — incremental-pull cursor for external loops. */
  afterId?: number;
  sinceMs?: number;
  untilMs?: number;
  /** Default 100, max 10000. */
  limit?: number;
}

interface CountFilter {
  channel?: string;
  sinceMs?: number;
  untilMs?: number;
  /** "day" groups by UTC calendar day (YYYY-MM-DD). */
  groupBy?: "sender" | "channel" | "day";
}

/** group is null when no groupBy was given (single total row). */
interface CountRecord {
  group: string | null;
  count: number;
}

interface PostMessageInput {
  /** Must exist — create with ensureChannel first. */
  channel: string;
  /** Ensured automatically (registered as an agent row if missing). */
  sender: string;
  content: string;
  /**
   * Explicit push targets ("*" = @all). Omitted → mentions are extracted
   * from content (@agent-name / @all), matching normal messaging behavior.
   */
  mentions?: string[];
}

/** Read-only surface — what \`storage\` implements in admin_search runs. */
interface StorageSearchApi {
  listAgents(): AgentRecord[];
  getAgent(id: string): AgentRecord | null;
  listChannels(): ChannelRecord[];
  getChannel(name: string): ChannelRecord | null;
  /** Throws if the channel does not exist. */
  listMembers(channel: string): MemberRecord[];
  /** Filtered scan, ascending by id. Never touches any agent's unread cursor. */
  getMessages(filter?: MessageFilter): MessageRecord[];
  /** OLAP-style aggregation over message history. */
  countMessages(filter?: CountFilter): CountRecord[];
  /** Highest message id — cheap high-water mark for incremental loops. */
  getMaxMessageId(): number;
}

/** Full surface — what \`storage\` implements in admin_execute runs. */
interface StorageExecuteApi extends StorageSearchApi {
  /** Register an external app (or any agent id) so it can send. Idempotent. */
  ensureAgent(id: string): AgentRecord;
  /** Create a channel if missing (creator auto-joins). Rejects DM-style names. Idempotent. */
  ensureChannel(name: string, createdBy: string): ChannelRecord;
  /** Subscribe an agent to a channel (it will see and be pushed its messages). Idempotent. */
  addMember(channel: string, agentId: string): void;
  /**
   * Post to a channel — this IS delivery (see DELIVERY MODEL above).
   * @example Push an issue-tracker event to every live member:
   *   storage.ensureChannel("eng-triage", "linear-hook");
   *   storage.postMessage({ channel: "eng-triage", sender: "linear-hook",
   *     content: "LIN-142 moved to In Review", mentions: ["*"] });
   */
  postMessage(input: PostMessageInput): MessageRecord;
  /** DM an existing agent — always pushes to both parties, no mentions needed. */
  postDirectMessage(input: { from: string; to: string; content: string }): MessageRecord;
}

/**
 * In admin_search runs, \`storage\` implements only StorageSearchApi — the
 * write methods are absent at runtime.
 */
declare const storage: StorageExecuteApi;
`;
