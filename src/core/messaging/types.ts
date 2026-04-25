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

export type HeartbeatResult = "ok" | "lost";

export interface UnreadResult {
  channel: string;
  messages: Message[];
  is_dm: boolean;
}
