import { readFileSync } from "node:fs";
import type { MessagingService } from "../../core/messaging/service";
import type { ChannelRepository } from "../../core/ports";

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
  "send", "members", "help", "quit", "continue",
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
  svc: MessagingService,
  channelRepo: ChannelRepository,
  state: ReplState,
): CommandResult {
  switch (cmd.name) {
    case "channels": {
      const channels = svc.listChannels();
      if (channels.length === 0) return { output: ["No channels"] };
      return { output: channels.map(ch => `  ${ch.name}`) };
    }

    case "agents": {
      const agents = svc.listAgents();
      if (agents.length === 0) return { output: ["No agents"] };
      return { output: agents.map(a => `  ${a.id}`) };
    }

    case "join": {
      const channelName = cmd.args;
      if (!channelName) return { output: ["Usage: /join <channel>"] };
      try {
        svc.subscribe(state.agentId, channelName);
      } catch (err) {
        return { output: [(err as Error).message] };
      }
      // Sync in-memory cursor from the DB PULL read cursor to prevent historical message flood
      // (the REPL is a pull reader — NOT the push delivery cursor, I10/F4).
      state.cursors.set(channelName, svc.getReadCursor(state.agentId, channelName));
      state.joinedChannels.add(channelName);
      return { output: [`Joined #${channelName}`], channelChange: channelName };
    }

    case "create": {
      const channelName = cmd.args;
      if (!channelName) return { output: ["Usage: /create <channel>"] };
      svc.createChannel(state.agentId, channelName);
      return { output: [`Created #${channelName}`] };
    }

    case "history": {
      let limit = parseInt(cmd.args, 10);
      if (!Number.isFinite(limit) || limit <= 0) limit = 20;

      const channel = channelRepo.findByName(state.activeChannel);
      if (!channel) return { output: ["Channel not found"] };

      const rows = svc.readRecent(state.activeChannel, limit);

      if (rows.length === 0) return { output: ["No messages"] };
      return { output: [], messages: rows.map(r => ({ agent_id: r.agent_id, content: r.content })) };
    }

    case "send": {
      const match = cmd.args.match(/^-f\s+(.+)$/);
      if (!match) return { output: ["Usage: /send -f <path>"] };
      const filePath = match[1]!.trim();
      try {
        const content = readFileSync(filePath, "utf-8");
        svc.send(state.agentId, state.activeChannel, content, { human: true });
        return {
          output: [],
          localEcho: { agent_id: state.agentId, content },
        };
      } catch (err) {
        return { output: [`Failed to read file: ${(err as Error).message}`] };
      }
    }

    case "members": {
      const members = svc.listMembers(state.activeChannel);
      if (members.length === 0) return { output: ["No members"] };
      return { output: members.map(m => `  ${m.agent_id} ${m.active ? "(active)" : "(inactive)"}`) };
    }

    case "continue": {
      let amount = parseInt(cmd.args, 10);
      if (!Number.isFinite(amount) || amount <= 0) amount = 4;
      const result = svc.continueChannel(state.agentId, state.activeChannel, amount);
      return { output: [`Bumped ${state.activeChannel}: hop count ${result.hopCount}/${result.maxHops} (+${result.bumped})`] };
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
          "  /continue [N]    -- Resume hop-limited channel (+N hops, default 4)",
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
