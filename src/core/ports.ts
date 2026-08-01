import type {
  Agent,
  Channel,
  Message,
  HeartbeatResult,
} from "./messaging/types";
import type {
  AdminValue,
  AdminRow,
  AdminExecuteResult,
  AdminInterfaceDescription,
} from "./admin/types";

// --- Storage ports (core defines, adapters implement) ---

export interface AgentRepository {
  findById(id: string): Agent | null;
  register(agentId: string, pid: number): Agent;
  heartbeatOrReclaim(agentId: string, pid: number): HeartbeatResult;
  listAll(): Agent[];
  clearPid(id: string, expectedPid: number): void;
}

export interface ChannelRepository {
  findByName(name: string): Channel | null;
  create(name: string, createdBy: string): Channel;
  list(): Channel[];
  addMember(agentId: string, channelId: number, initialCursorId: number): void;
  getMembers(channelId: number): Agent[];
  renameWithAnnouncement(
    channelId: number,
    newName: string,
    agentId: string
  ): Channel;
}

export interface MessageRepository {
  insertAndJoinSender(
    channelId: number,
    agentId: string,
    content: string,
    mentions: string[]
  ): Message;
  readForwardAndAdvance(
    agentId: string,
    channelId: number,
    limit: number
  ): Message[];
  readBefore(
    channelId: number,
    beforeId: number,
    limit: number,
    excludeAgent: string
  ): Message[];
  // Pure history snapshot: most recent `limit` messages in ascending order,
  // all senders included. Never touches cursors.
  readRecent(channelId: number, limit: number): Message[];
}

// --- Admin storage port (elevated access plane) ---
// Core's need: give approved external apps direct, elevated access to stored
// data through exactly two generic operations, plus a self-describing contract
// so clients can learn the provider's query language without core knowing it.
// Queries and statements are opaque to core; the provider defines their
// meaning and documents it in the typehead it returns from describe().

export interface AdminStoragePort {
  describe(): AdminInterfaceDescription;
  // Read-only query. Providers MUST reject anything that mutates state.
  search(query: string, params: AdminValue[]): AdminRow[];
  // Single mutating statement, applied atomically.
  execute(statement: string, params: AdminValue[]): AdminExecuteResult;
}

// --- Push notification contract ---
// Defined in core so both the notification and transport adapters can depend
// on it without importing each other.

export interface NotificationMeta {
  channel_name: string;
  sender: string;
  message_id: string;
}

export interface NotificationPort {
  notify(content: string, meta: NotificationMeta): Promise<void>;
  // Coarse activity signal: fired at most once per poll tick per channel that
  // gained messages, regardless of mentions (the mention filter applies to
  // notify() only). Optional — transports without a channel-activity surface
  // simply omit it.
  notifyChannelActivity?(channelName: string): Promise<void>;
}
