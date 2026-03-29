// src/repl/commands.ts

import { readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import {
  createChannel,
  listChannels,
  sendMessage,
  readMessages,
  listAgents,
  listChannelMembers,
} from "../modules/messaging/tools";
import { sanitize } from "./display";

export interface Command {
  name: string;
  args: string;
}

export interface CommandResult {
  output: string[];
  channelChange?: string;
  quit?: boolean;
}

export function parseCommand(line: string): Command | null {
  if (!line.startsWith("/")) return null;
  const spaceIdx = line.indexOf(" ");
  if (spaceIdx === -1) return { name: line.slice(1), args: "" };
  return { name: line.slice(1, spaceIdx), args: line.slice(spaceIdx + 1).trim() };
}

export function handleCommand(
  cmd: Command,
  db: Database,
  agentId: string,
  activeChannel: string,
  cursors: Map<string, number>
): CommandResult {
  switch (cmd.name) {
    case "channels": {
      const channels = listChannels(db);
      const lines = channels.map(
        (c) => `  ${sanitize(c.name)}${c.name === activeChannel ? " (active)" : ""}`
      );
      return { output: lines.length ? lines : ["No channels"] };
    }
    case "agents": {
      const agents = listAgents(db);
      const lines = agents.map((a) => `  ${sanitize(a.id)}`);
      return { output: lines.length ? lines : ["No agents"] };
    }
    case "join": {
      if (!cmd.args) {
        return { output: ["Usage: /join <channel>"] };
      }
      createChannel(db, cmd.args, agentId);
      if (!cursors.has(cmd.args)) {
        const maxRow = db
          .query(
            `SELECT MAX(m.id) as max_id
             FROM messages m
             JOIN channels ch ON m.channel_id = ch.id
             WHERE ch.name = ?`
          )
          .get(cmd.args) as { max_id: number | null } | null;
        cursors.set(cmd.args, maxRow?.max_id ?? 0);
      }
      return {
        output: [`Switched to #${sanitize(cmd.args)}`],
        channelChange: cmd.args,
      };
    }
    case "create": {
      if (!cmd.args) {
        return { output: ["Usage: /create <channel>"] };
      }
      createChannel(db, cmd.args, agentId);
      return { output: [`Created #${sanitize(cmd.args)}`] };
    }
    case "history": {
      const parsed = parseInt(cmd.args);
      const n = parsed > 0 ? parsed : 20;
      const msgs = readMessages(db, agentId, activeChannel, {
        before_id: Number.MAX_SAFE_INTEGER,
        limit: n,
      });
      if (msgs.length === 0) {
        return { output: ["No message history"] };
      }
      return {
        output: msgs.map((msg) => `[${sanitize(msg.agent_id)}] ${sanitize(msg.content)}`),
      };
    }
    case "send": {
      const match = cmd.args.match(/^-f\s+(.+)$/);
      if (!match) {
        return { output: ["Usage: /send -f <path>"] };
      }
      try {
        const content = readFileSync(match[1]!, "utf-8");
        sendMessage(db, agentId, activeChannel, content);
        return { output: [`[${agentId}] (file: ${match[1]})`] };
      } catch (err: any) {
        return { output: [`Error: ${err.message}`] };
      }
    }
    case "members": {
      const members = listChannelMembers(db, activeChannel);
      if (members.length === 0) {
        return { output: ["No members in this channel"] };
      }
      return {
        output: members.map(
          (m) => `  ${sanitize(m.agent_id)} ${m.active ? "(active)" : "(inactive)"}`
        ),
      };
    }
    case "help": {
      return {
        output: [
          "Commands:",
          "  /channels         List all channels",
          "  /agents           List all known agents",
          "  /members          List channel members (agents appear after sending/reading)",
          "  /join <channel>   Switch to a channel",
          "  /create <channel> Create a channel without switching",
          "  /history [N]      Show last N messages (default 20)",
          "  /send -f <path>   Send file contents",
          "  /help             Show this help",
          "  /quit             Exit",
        ],
      };
    }
    case "quit":
      return { output: [], quit: true };
    default:
      return { output: [`Unknown command: /${cmd.name}. Type /help for commands.`] };
  }
}
