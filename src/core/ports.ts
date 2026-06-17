// src/core/ports.ts
import type {
  Agent,
  Channel,
  Message,
  CursorWithChannel,
  HeartbeatResult,
  HopCheckResult,
} from "./messaging/types";
import type { AgentProfile, ProfileFields, NamedProfileFields } from "./profiles/types";

// --- Storage ports (core defines, adapters implement) ---

export interface AgentRepository {
  findById(id: string): Agent | null;
  register(agentId: string, pid: number, profileFields?: NamedProfileFields): Agent;
  heartbeatOrReclaim(agentId: string, pid: number): HeartbeatResult;
  listAll(): Agent[];
  clearPid(id: string, expectedPid: number): void;
  findByBaseName(baseName: string): Agent[];
  registerWithProfile(
    baseName: string,
    pid: number,
    maxInstances: number,
    profileFields: ProfileFields
  ): { agent: Agent; registeredName: string; instanceNumber: number | null };
}

export interface ProfileRepository {
  getProfile(baseName: string): AgentProfile | null;
  listProfiles(): AgentProfile[];
  getBaseNames(): Set<string>;
}

export interface ChannelRepository {
  findByName(name: string): Channel | null;
  create(name: string, createdBy: string, maxHops?: number): Channel;
  list(): Channel[];
  addMember(agentId: string, channelId: number, initialCursorId: number): void;
  getMembers(channelId: number): Agent[];
  getMemberCount(channelId: number): number;
  renameWithAnnouncement(
    channelId: number,
    newName: string,
    agentId: string
  ): Channel;
  checkAndIncrementHop(channelId: number): HopCheckResult;
  resetHopCount(channelId: number): void;
  bumpHopAllowance(channelId: number, amount: number): HopCheckResult;
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
  readRecent(channelId: number, limit: number): Message[];
  readSince(
    channelId: number,
    sinceId: number,
    limit: number,
    excludeAgent: string
  ): Message[];
}

export interface CursorRepository {
  get(agentId: string, channelId: number): number;
  listForAgent(agentId: string): CursorWithChannel[];
}

// --- Notification port ---

export interface NotificationMeta {
  channel_name: string;
  sender: string;
  message_id: string;
}

export interface NotificationPort {
  notify(content: string, meta: NotificationMeta): Promise<void>;
}

export interface NotificationDispatch {
  dispatch(notification: {
    channelName: string;
    sender: string;
    content: string;
    messageId: number;
    isDm: boolean;
    targetAgents: string[];
  }): void;
}

