export interface Agent {
  id: string;
  created_at: number;
  last_seen_at: number;
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
}