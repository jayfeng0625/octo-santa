// src/repl/poll.ts

import type { Database } from "bun:sqlite";

export interface PollState {
  activeChannel: string;
  cursors: Map<string, number>;
}

export interface PollMessage {
  channel: string;
  agent: string;
  content: string;
  id: number;
}

export function pollTick(
  db: Database,
  agentId: string,
  state: PollState
): PollMessage[] {
  const results: PollMessage[] = [];

  for (const [channelName, lastSeenId] of state.cursors) {
    const rows = db
      .query(
        `SELECT m.id, m.agent_id, m.content
         FROM messages m
         JOIN channels ch ON m.channel_id = ch.id
         WHERE ch.name = ? AND m.id > ? AND m.agent_id != ?
         ORDER BY m.id ASC`
      )
      .all(channelName, lastSeenId, agentId) as {
        id: number;
        agent_id: string;
        content: string;
      }[];

    for (const msg of rows) {
      results.push({
        channel: channelName,
        agent: msg.agent_id,
        content: msg.content,
        id: msg.id,
      });
      state.cursors.set(channelName, msg.id);
    }
  }

  return results;
}
