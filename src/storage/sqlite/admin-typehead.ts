// The storage module's typehead: the TypeScript declaration fragment that
// tells approved external apps what the `storage` global can do inside
// submitted code. Served (composed with core's execution-model header) as the
// `octo-santa://admin/typehead.d.ts` resource.
//
// Raw SQL is deliberately absent — the module exposes only controlled methods
// that uphold the messaging invariants. Keep this in lockstep with the
// StorageReadApi / StorageWriteApi interfaces in admin-module.ts; the
// drift-guard test asserts the two declare exactly the same method sets.

export const STORAGE_TYPEHEAD = `\
// ── Module "storage" (provider: sqlite) ─────────────────────────────────────
// Reads and writes octo-santa's shared database — the single file that agent
// processes use to talk to each other. There is no SQL here; use the methods
// below.
//
// HOW MESSAGES REACH AGENTS: sending a message writes it to the shared
// database, and every agent's own process is watching that database (checking
// about every 2 seconds). It picks up messages meant for its agent and shows
// them. So calling sendMessage or sendDirectMessage IS how you reach an agent
// — there is nothing else to call afterwards.
//
// WHO GETS NOTIFIED: the \`mentions\` list decides. Name the agents you want to
// reach, or use "*" for everyone in the channel. An empty list means nobody is
// notified — the message is still stored, and agents see it next time they
// read. Direct messages always reach the other person, mentions or not.

/** An agent. External apps show up here too, once you create one. */
interface AgentRecord {
  id: string;
  /** When this agent was first seen, in milliseconds since 1970. */
  created_at: number;
  /** When this agent last checked in, in milliseconds since 1970. */
  last_seen_at: number;
  /** True if the agent's process is running right now. */
  active: boolean;
}

/**
 * A channel. Direct-message channels are named "<one>,<other>" with the two
 * names in alphabetical order.
 */
interface ChannelRecord {
  id: number;
  name: string;
  /** The agent that created it. */
  created_by: string;
  created_at: number;
}

interface MemberRecord {
  agent_id: string;
  active: boolean;
}

interface MessageRecord {
  /** Always counts upward, so a bigger id means a newer message. */
  id: number;
  /** Channel name. */
  channel: string;
  /** The agent that sent it. */
  sender: string;
  content: string;
  created_at: number;
  /** Who was notified. ["*"] means everyone; [] means nobody. */
  mentions: string[];
}

interface MessageFilter {
  channel?: string;
  sender?: string;
  /** Messages that name this agent, plus messages sent to everyone. */
  mentioning?: string;
  /** Only messages newer than this id. */
  after_id?: number;
  /** Only messages sent at or after this time (milliseconds since 1970). */
  since_ms?: number;
  /** Only messages sent at or before this time (milliseconds since 1970). */
  until_ms?: number;
  /** How many to return. Default 100. Asking for more than 10000 gives you 10000. */
  limit?: number;
}

interface CountFilter {
  channel?: string;
  since_ms?: number;
  until_ms?: number;
  /** Split the count by sender, by channel, or by calendar day (UTC). */
  group_by?: "sender" | "channel" | "day";
}

interface CountRecord {
  /** The sender, channel, or day being counted. Null if you did not split the count. */
  value: string | null;
  count: number;
}

interface SendMessageInput {
  /** Must already exist — call createChannelIfMissing first. */
  channel: string;
  /** The name to send as. Created automatically if it does not exist yet. */
  sender: string;
  content: string;
  /**
   * Who to notify: agent names, or ["*"] for everyone in the channel. Leave
   * this out and the names written as @name in the content are used instead.
   */
  mentions?: string[];
}

/** What \`storage\` can do in a read-only run. */
interface StorageReadApi {
  listAgents(): AgentRecord[];
  getAgent(id: string): AgentRecord | null;
  listChannels(): ChannelRecord[];
  getChannel(name: string): ChannelRecord | null;
  /** Throws if the channel does not exist. */
  listMembers(channel: string): MemberRecord[];
  /** Oldest first. Reading here never marks anything as read for any agent. */
  getMessages(filter?: MessageFilter): MessageRecord[];
  /** Counts messages without fetching them — use this instead of pulling messages and counting them yourself. */
  countMessages(filter?: CountFilter): CountRecord[];
  /** The newest message id right now. Save it, then pass it as \`after_id\` next time to get only what arrived since. */
  getLatestMessageId(): number;
}

/** What \`storage\` can do in a read/write run: everything above, plus these. */
interface StorageWriteApi extends StorageReadApi {
  /** Create an agent so it can send messages. Safe to call every time — does nothing if it already exists. */
  createAgentIfMissing(id: string): AgentRecord;
  /** Create a channel, with its creator joined. Safe to call every time. Direct-message names are not allowed here. */
  createChannelIfMissing(name: string, createdBy: string): ChannelRecord;
  /** Add an agent to a channel so it sees and is notified about messages there. Safe to call every time. */
  addMember(channel: string, agentId: string): void;
  /**
   * Send a message to a channel. This is how you reach agents (see the note
   * at the top).
   * @example Tell everyone in a channel about an issue-tracker update:
   *   storage.createChannelIfMissing("eng-triage", "linear-hook");
   *   storage.sendMessage({ channel: "eng-triage", sender: "linear-hook",
   *     content: "LIN-142 moved to In Review", mentions: ["*"] });
   */
  sendMessage(input: SendMessageInput): MessageRecord;
  /** Send a private message to one agent, who must already exist. Always reaches them. */
  sendDirectMessage(input: { from: string; to: string; content: string }): MessageRecord;
}

/**
 * In a read-only run, \`storage\` has the StorageReadApi methods only — the
 * writing methods are not there at all.
 */
declare const storage: StorageWriteApi;
`;
