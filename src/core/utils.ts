// src/core/utils.ts
import type { Agent } from "./messaging/types";

const AGENT_NAME_RE = /^[\w-]+$/;
const RESERVED_AGENT_NAMES = new Set(["all", "here", "_system"]);
const DM_CHANNEL_RE = /^([\w-]+),([\w-]+)$/;
const MENTION_RE = /@([\w-]+)/g;

/** Staleness threshold for PID reuse detection (15 minutes). */
export const PID_STALE_MS = 15 * 60 * 1000;

export function isDmChannel(channelName: string): boolean {
  const m = DM_CHANNEL_RE.exec(channelName);
  if (!m) return false;
  return m[1]! < m[2]!;
}

export function assertDmAccess(
  channelName: string,
  agentId: string
): void {
  const m = DM_CHANNEL_RE.exec(channelName);
  if (!m || m[1]! >= m[2]!) return;
  if (agentId !== m[1] && agentId !== m[2]) {
    throw new Error(
      `DM channel "${channelName}" is private to ${m[1]} and ${m[2]}`
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
  validAgentIds: string[],
  profileBaseNames?: Set<string>
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
      // Direct agent ID — preferred over base name
      result.add(name);
    } else if (profileBaseNames?.has(name)) {
      // Pool base name mention — stored as-is; expanded at dispatch time
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
    if (errno.code === "EPERM") return true;
    return false;
  }
}

export function isAgentActive(agent: Agent): boolean {
  if (agent.pid === null) return false;
  if (!isProcessAlive(agent.pid)) return false;
  return Date.now() - agent.last_seen_at <= PID_STALE_MS;
}
