export const DEFAULT_MAX_HOPS = 200;
export const MAX_HOPS_CAP = 1000;

export interface Agent {
  id: string;
  created_at: number;
  last_seen_at: number;
  pid: number | null;
  registered_at: number | null;
  // New nullable fields (added for persistent agent profiles)
  base_name: string | null;
  persona: string | null;
  objective: string | null;
  instructions: string | null;
}

export interface Channel {
  id: number;
  name: string;
  created_by: string;
  created_at: number;
  max_hops: number;
  hop_count: number;
}

export interface HopCheckResult {
  allowed: boolean;
  hopCount: number;
  maxHops: number;
}

export interface SendOptions {
  human?: boolean;
}

export interface ContinueResult {
  channel: string;
  hopCount: number;
  maxHops: number;
  bumped: number;
}

export interface Message {
  id: number;
  channel_id: number;
  agent_id: string;
  content: string;
  created_at: number;
  mentions: string; // JSON array, e.g. '["agent-a"]' or '["*"]' or '[]'
}

export interface ChannelMember {
  agent_id: string;
  active: boolean;
}

export interface ReadOptions {
  limit?: number;
  before_id?: number;
}

export interface CursorWithChannel {
  channelId: number;
  channelName: string;
  lastReadMessageId: number;
}

export type MessageWithChannel = Message & { channel_name: string };

export type HeartbeatResult = "ok" | "lost";

export interface UnreadResult {
  channel: string;
  messages: Message[];
  is_dm: boolean;
}
