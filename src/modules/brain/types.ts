export interface DomainConfig {
  identifier: string;
  tags: string[];
  description: string;
}

export interface BrainConfig {
  dirs: string[];
}

export interface OctoSantaConfig {
  domain?: DomainConfig;
  brain?: BrainConfig;
}

export interface BrainDoc {
  slug: string;
  path: string;       // relative path from CWD, e.g. "./brain/webhook-schemas.md"
  title: string;
  summary: string;
  tags: string[];
}

export interface Domain {
  identifier: string;
  cwd: string;
  tags: string;        // JSON array in DB
  description: string;
  registered_at: number;
}

export interface DomainClaim {
  agent_id: string;
  pid: number;
  domain_identifier: string;
  claimed_at: number;
}

export interface DomainExpert {
  identifier: string;
  tags: string[];
  description: string;
  active_sessions: string[];   // agent IDs with live PIDs
}
