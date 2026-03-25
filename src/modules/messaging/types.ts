export interface Agent {
  id: string;
  created_at: number;
  last_seen_at: number;
  pid: number | null;
  registered_at: number | null;
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