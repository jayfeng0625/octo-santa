import type {
  Agent,
  Channel,
  Message,
  HeartbeatResult,
} from "./messaging/types";
import type { AdminModuleDescription, CodeRunResult } from "./admin/types";

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

// --- Admin API ports (elevated code-mode access) ---
// Core's need: give approved external apps an elevated integration surface
// through exactly two generic operations — a read-only run and a read/write
// run — that execute caller-submitted code. Core stays agnostic about what
// the code can do: each module contributes a typed API object (bound as a
// global inside the code) plus a .d.ts fragment describing it, and never
// exposes its raw backend (SQL, files, wire protocols) through that API.
// Different modules may have entirely different interaction patterns; core
// only composes them.

export interface AdminModulePort {
  describe(): AdminModuleDescription;
  // Bound into read-only runs. Nothing reachable from this object may mutate
  // state — core cannot verify that, so it is a rule for implementers.
  createReadApi(): object;
  // Bound into read/write runs: the read surface plus the module's controlled
  // write methods.
  createWriteApi(): object;
}

// Executes caller-submitted code with the given globals bound. An adapter
// concern — transpilation, isolation, and timeouts all live outside core.
export interface CodeRunnerPort {
  // Language submitted code is written in, e.g. "typescript".
  readonly language: string;
  // Names the execution environment already uses; modules may not bind them.
  readonly reservedNames: readonly string[];
  run(code: string, bindings: Record<string, object>): Promise<CodeRunResult>;
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
