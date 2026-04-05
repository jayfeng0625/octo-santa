// src/core/ports.ts
import type {
  Agent,
  Channel,
  Message,
  CursorWithChannel,
  HeartbeatResult,
} from "./messaging/types";
import type { BrainDoc, DomainWithClaims } from "./brain/types";

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
  getMemberCount(channelId: number): number;
  getMaxMessageId(channelId: number): number;
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
  readRecent(channelId: number, limit: number): Message[];
  countSince(
    channelId: number,
    sinceId: number,
    excludeAgent: string
  ): number;
  readSince(
    channelId: number,
    sinceId: number,
    limit: number,
    excludeAgent: string
  ): Message[];
}

export interface CursorRepository {
  get(agentId: string, channelId: number): number;
  upsert(agentId: string, channelId: number, messageId: number): void;
  listForAgent(agentId: string): CursorWithChannel[];
}

export interface DomainRepository {
  register(
    identifier: string,
    cwd: string,
    tags: string[],
    description: string
  ): void;
  claim(agentId: string, pid: number, domainIdentifier: string): void;
  listWithClaims(): DomainWithClaims[];
  clearClaims(agentId: string, pid: number): void;
}

export interface BrainStore {
  scanDocs(): BrainDoc[];
  readDoc(slug: string): string;
  scanSharedDocs(): BrainDoc[];
  readSharedDoc(slug: string): string;
}

// --- Notification port ---

export interface NotificationPort {
  notify(content: string, meta: Record<string, string>): Promise<void>;
}
