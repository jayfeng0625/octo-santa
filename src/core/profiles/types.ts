import type { Agent } from "../messaging/types";

export interface ProfileFields {
  persona: string | null;
  objective: string | null;
  instructions: string | null;
}

export interface NamedProfileFields extends ProfileFields {
  baseName: string;
}

export interface AgentProfile extends ProfileFields {
  name: string;          // base name
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
  profile: (ProfileFields & { maxInstances: number }) | null;
  autoJoined: AutoJoinResult | null;
}
