import type { Agent } from "./messaging/types";

export const AGENT_NAME_RE = /^[\w-]+$/;
const RESERVED_AGENT_NAMES = new Set(["all", "here", "_system"]);
const DM_CHANNEL_RE = /^([\w-]+),([\w-]+)$/;
const MENTION_RE = /@([\w-]+)/g;

export const PID_STALE_MS = 15 * 60 * 1000;

// Channel-name and message-content rules. Single source of truth: the MCP
// transport's zod schemas and the admin module both build on these, so the
// two entry planes cannot drift apart on what they accept.
export const CHANNEL_NAME_RE = /^[\w.,@#-]+$/;
export const MAX_CHANNEL_NAME_LENGTH = 128;
export const MAX_MESSAGE_LENGTH = 100_000;
export const CHANNEL_NAME_RULE =
  "Channel name must contain only letters, digits, underscores, hyphens, dots, commas, @ or #";

export function validateChannelName(name: string): void {
  if (!name.trim()) throw new Error("channel name must not be empty");
  if (name.length > MAX_CHANNEL_NAME_LENGTH)
    throw new Error(
      `channel name must not exceed ${MAX_CHANNEL_NAME_LENGTH} characters`
    );
  if (!CHANNEL_NAME_RE.test(name)) throw new Error(CHANNEL_NAME_RULE);
}

export function validateMessageContent(content: string): void {
  if (!content.trim()) throw new Error("message content must not be empty");
  if (content.length > MAX_MESSAGE_LENGTH)
    throw new Error(
      `message content must not exceed ${MAX_MESSAGE_LENGTH} characters`
    );
}

export function dmChannelName(a: string, b: string): string {
  return [a, b].sort().join(",");
}

export function parseDmChannelName(
  name: string
): { lo: string; hi: string } | null {
  const m = DM_CHANNEL_RE.exec(name);
  if (!m || !(m[1]! < m[2]!)) return null;
  return { lo: m[1]!, hi: m[2]! };
}

export function isDmChannel(channelName: string): boolean {
  return parseDmChannelName(channelName) !== null;
}

export function assertDmAccess(channelName: string, agentId: string): void {
  const p = parseDmChannelName(channelName);
  if (!p) return;
  if (agentId !== p.lo && agentId !== p.hi) {
    throw new Error(
      `DM channel "${channelName}" is private to ${p.lo} and ${p.hi}`
    );
  }
}

export function validateAgentName(agentId: string): void {
  if (!agentId.trim()) throw new Error("agent_id must not be empty");
  if (!AGENT_NAME_RE.test(agentId))
    throw new Error(
      `agent_id must match [\\w-]+ (letters, digits, underscores, hyphens), got "${agentId}"`
    );
  if (RESERVED_AGENT_NAMES.has(agentId))
    throw new Error(
      `agent_id "${agentId}" is reserved for broadcast mentions`
    );
}

export function extractMentions(
  content: string,
  validAgentIds: string[]
): string[] {
  const matches = content.matchAll(MENTION_RE);
  const validSet = new Set(validAgentIds);
  const result = new Set<string>();
  let hasBroadcast = false;

  for (const match of matches) {
    const name = match[1]!;
    if (name === "all" || name === "here") {
      hasBroadcast = true;
    } else if (validSet.has(name)) {
      result.add(name);
    }
  }

  if (hasBroadcast) return ["*"];
  return [...result];
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    // EPERM means the process exists but belongs to another user.
    if (errno.code === "EPERM") return true;
    return false;
  }
}

export type AgentLiveness = Pick<Agent, "pid" | "last_seen_at">;

export function isAgentActive(agent: AgentLiveness): boolean {
  if (agent.pid === null) return false;
  if (!isProcessAlive(agent.pid)) return false;
  return Date.now() - agent.last_seen_at <= PID_STALE_MS;
}
