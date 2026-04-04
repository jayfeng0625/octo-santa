import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  listChannels,
  listAgents,
  listChannelMembers,
  createChannel,
  subscribe,
  sendMessage,
} from "../modules/messaging/tools";

export interface ReplState {
  activeChannel: string;
  joinedChannels: Set<string>;
  cursors: Map<string, number>;
  agentId: string;
}

export interface ParsedCommand {
  name: string;
  args: string;
}

export interface CommandResult {
  output: string[];
  channelChange?: string;
  exit?: boolean;
  localEcho?: { agent_id: string; content: string };
  messages?: { agent_id: string; content: string }[];
}

export const KNOWN_COMMANDS = new Set([
  "channels", "agents", "join", "create", "history",
  "send", "members", "help", "quit",
]);

export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  if (trimmed.includes("\n")) return null;
  const spaceIdx = trimmed.indexOf(" ");
  const token = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
  if (!KNOWN_COMMANDS.has(token)) return null;
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  return { name: token, args };
}

export function executeCommand(
  cmd: ParsedCommand,
  db: Database,
  state: ReplState,
): CommandResult {
  switch (cmd.name) {
    case "channels": {
      const channels = listChannels(db);
      if (channels.length === 0) return { output: ["No channels"] };
      return { output: channels.map(ch => `  ${ch.name}`) };
    }

    case "agents": {
      const agents = listAgents(db);
      if (agents.length === 0) return { output: ["No agents"] };
      return { output: agents.map(a => `  ${a.id}`) };
    }

    case "join": {
      const channelName = cmd.args;
      if (!channelName) return { output: ["Usage: /join <channel>"] };
      try {
        subscribe(db, state.agentId, channelName);
      } catch (err) {
        return { output: [(err as Error).message] };
      }
      // Sync in-memory cursor from DB to prevent historical message flood
      const ch = db.query("SELECT id FROM channels WHERE name = ?").get(channelName) as { id: number } | null;
      if (ch) {
        const cur = db.query("SELECT last_read_message_id FROM cursors WHERE agent_id = ? AND channel_id = ?")
          .get(state.agentId, ch.id) as { last_read_message_id: number } | null;
        if (cur) state.cursors.set(channelName, cur.last_read_message_id);
      }
      state.joinedChannels.add(channelName);
      return { output: [`Joined #${channelName}`], channelChange: channelName };
    }

    case "create": {
      const channelName = cmd.args;
      if (!channelName) return { output: ["Usage: /create <channel>"] };
      createChannel(db, channelName, state.agentId);
      return { output: [`Created #${channelName}`] };
    }

    case "history": {
      let limit = parseInt(cmd.args, 10);
      if (!Number.isFinite(limit) || limit <= 0) limit = 20;

      const channel = db.query("SELECT id FROM channels WHERE name = ?").get(state.activeChannel) as { id: number } | null;
      if (!channel) return { output: ["Channel not found"] };

      const rows = db.query(
        `SELECT agent_id, content FROM messages
         WHERE channel_id = ?
         ORDER BY id DESC
         LIMIT ?`
      ).all(channel.id, limit) as { agent_id: string; content: string }[];

      if (rows.length === 0) return { output: ["No messages"] };
      rows.reverse();
      return { output: [], messages: rows };
    }

    case "send": {
      const match = cmd.args.match(/^-f\s+(.+)$/);
      if (!match) return { output: ["Usage: /send -f <path>"] };
      const filePath = match[1]!.trim();
      try {
        const content = readFileSync(filePath, "utf-8");
        sendMessage(db, state.agentId, state.activeChannel, content);
        return {
          output: [],
          localEcho: { agent_id: state.agentId, content },
        };
      } catch (err) {
        return { output: [`Failed to read file: ${(err as Error).message}`] };
      }
    }

    case "members": {
      const members = listChannelMembers(db, state.activeChannel);
      if (members.length === 0) return { output: ["No members"] };
      return { output: members.map(m => `  ${m.agent_id} ${m.active ? "(active)" : "(inactive)"}`) };
    }

    case "help":
      return {
        output: [
          "Commands:",
          "  /channels        — List all channels",
          "  /agents          — List all known agents",
          "  /join <channel>  — Switch active channel",
          "  /create <channel> — Create a new channel",
          "  /history [N]     — Show last N messages (default 20)",
          "  /send -f <path>  — Send file contents",
          "  /members         — List channel members",
          "  /help            — Show this help",
          "  /quit            — Exit",
        ],
      };

    case "quit":
      return { output: [], exit: true };

    default:
      return { output: [`Unknown command: ${cmd.name}`] };
  }
}
