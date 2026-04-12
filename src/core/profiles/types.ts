export interface AgentProfile {
  name: string;          // base name
  persona: string | null;
  objective: string | null;
  maxInstances: number;  // >= 1
  autoJoinChannels: string[];
}

export interface AutoJoinResult {
  succeeded: string[];
  failed: Array<{ channel: string; reason: string }>;
}

export interface RegisterResult {
  // All Agent fields
  id: string;
  created_at: number;
  last_seen_at: number;
  pid: number | null;
  registered_at: number | null;
  base_name: string | null;
  persona: string | null;
  objective: string | null;
  // Profile-specific
  registeredName: string;
  baseName: string | null;
  instanceNumber: number | null;
  profile: {
    persona: string | null;
    objective: string | null;
    maxInstances: number;
  } | null;
  autoJoined: AutoJoinResult | null;
}
