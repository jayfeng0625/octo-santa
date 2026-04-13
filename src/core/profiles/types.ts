import type { Agent } from "../messaging/types";

export interface AgentProfile {
  name: string;          // base name
  persona: string | null;
  objective: string | null;
  instructions: string | null;
  maxInstances: number;  // >= 1
  autoJoinChannels: string[];
}

export interface AutoJoinResult {
  succeeded: string[];
  failed: Array<{ channel: string; reason: string }>;
}

export interface RegisterResult extends Agent {
  registeredName: string;
  baseName: string | null;
  instanceNumber: number | null;
  profile: {
    persona: string | null;
    objective: string | null;
    instructions: string | null;
    maxInstances: number;
  } | null;
  autoJoined: AutoJoinResult | null;
}
