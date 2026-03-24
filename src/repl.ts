// src/repl.ts

import { readFileSync } from "node:fs";
import * as readline from "node:readline";
import type { Database } from "bun:sqlite";
import {
  createChannel,
  listChannels,
  sendMessage,
  readMessages,
  listAgents,
} from "./modules/messaging/tools";
import type { Message } from "./modules/messaging/types";
import { openDb } from "./bootstrap";

// --- Arg Parsing ---

export interface Args {
  mode: "repl" | "send";
  agentId: string;
  channel: string;
  filePath?: string;
}

export function parseArgs(argv: string[]): Args {
  const raw = argv.slice(2);
  let mode: "repl" | "send" = "repl";
  let agentId = "";
  let channel = "";
  let filePath: string | undefined;

  let i = 0;
  if (raw[0] === "send") {
    mode = "send";
    i = 1;
  }

  for (; i < raw.length; i++) {
    switch (raw[i]) {
      case "--as":
        agentId = raw[++i] ?? "";
        break;
      case "-c":
        channel = raw[++i] ?? "";
        break;
      case "-f":
        filePath = raw[++i] ?? "";
        break;
    }
  }

  if (!agentId) throw new Error("--as <name> is required");
  if (!/^[\w-]+$/.test(agentId))
    throw new Error("--as name must match [\\w-]+ (letters, digits, underscores, hyphens)");
  if (agentId === "all" || agentId === "here")
    throw new Error(`"${agentId}" is a reserved name`);
  if (!channel) throw new Error("-c <channel> is required");

  return { mode, agentId, channel, ...(filePath ? { filePath } : {}) };
}

// --- Display ---

/** Strip ANSI escape sequences and control characters (except \n and \t) */
function sanitize(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\r]/g, "");
}

export function formatMessage(
  msg: { agent_id: string; content: string },
  channelName: string,
  activeChannel: string
): string {
  const prefix = channelName === activeChannel ? "" : `[#${sanitize(channelName)}]`;
  return `${prefix}[${sanitize(msg.agent_id)}] ${sanitize(msg.content)}`;
}

// --- Slash Commands ---

export interface Command {
  name: string;
  args: string;
}

export function parseCommand(line: string): Command | null {
  if (!line.startsWith("/")) return null;
  const spaceIdx = line.indexOf(" ");
  if (spaceIdx === -1) return { name: line.slice(1), args: "" };
  return { name: line.slice(1, spaceIdx), args: line.slice(spaceIdx + 1).trim() };
}

export interface ReplState {
  activeChannel: string;
  cursors: Map<string, number>;
}

/** Returns true for normal commands, false if the REPL should exit (/quit). */
export function handleCommand(
  cmd: Command,
  db: Database,
  agentId: string,
  state: ReplState,
  print: (text: string) => void
): boolean {
  switch (cmd.name) {
    case "channels": {
      const channels = listChannels(db);
      const lines = channels.map(
        (c) => `  ${sanitize(c.name)}${c.name === state.activeChannel ? " (active)" : ""}`
      );
      print(lines.length ? lines.join("\n") : "No channels");
      return true;
    }
    case "agents": {
      const agents = listAgents(db);
      const lines = agents.map((a) => `  ${sanitize(a.id)}`);
      print(lines.length ? lines.join("\n") : "No agents");
      return true;
    }
    case "join": {
      if (!cmd.args) {
        print("Usage: /join <channel>");
        return true;
      }
      createChannel(db, cmd.args, agentId); // ensure channel exists
      if (!state.cursors.has(cmd.args)) {
        const maxRow = db
          .query(
            `SELECT MAX(m.id) as max_id
             FROM messages m
             JOIN channels ch ON m.channel_id = ch.id
             WHERE ch.name = ?`
          )
          .get(cmd.args) as { max_id: number | null } | null;
        state.cursors.set(cmd.args, maxRow?.max_id ?? 0);
      }
      state.activeChannel = cmd.args;
      print(`Switched to #${sanitize(cmd.args)}`);
      return true;
    }
    case "create": {
      if (!cmd.args) {
        print("Usage: /create <channel>");
        return true;
      }
      createChannel(db, cmd.args, agentId);
      print(`Created #${sanitize(cmd.args)}`);
      return true;
    }
    case "history": {
      const parsed = parseInt(cmd.args);
      const n = parsed > 0 ? parsed : 20;
      const msgs = readMessages(db, agentId, state.activeChannel, {
        before_id: Number.MAX_SAFE_INTEGER,
        limit: n,
      });
      if (msgs.length === 0) {
        print("No message history");
      } else {
        for (const msg of msgs) {
          print(`[${sanitize(msg.agent_id)}] ${sanitize(msg.content)}`);
        }
      }
      return true;
    }
    case "send": {
      const match = cmd.args.match(/^-f\s+(.+)$/);
      if (!match) {
        print("Usage: /send -f <path>");
        return true;
      }
      try {
        const content = readFileSync(match[1]!, "utf-8");
        sendMessage(db, agentId, state.activeChannel, content);
        print(`[${agentId}] (file: ${match[1]})`);
      } catch (err: any) {
        print(`Error: ${err.message}`);
      }
      return true;
    }
    case "help": {
      print(
        [
          "Commands:",
          "  /channels         List all channels",
          "  /agents           List all registered agents",
          "  /join <channel>   Switch to a channel",
          "  /create <channel> Create a channel without switching",
          "  /history [N]      Show last N messages (default 20)",
          "  /send -f <path>   Send file contents",
          "  /help             Show this help",
          "  /quit             Exit",
        ].join("\n")
      );
      return true;
    }
    case "quit":
      return false;
    default:
      print(`Unknown command: /${cmd.name}. Type /help for commands.`);
      return true;
  }
}

// --- Poll Loop ---

export function pollTick(
  db: Database,
  agentId: string,
  state: ReplState,
  print: (text: string) => void
): void {
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
      print(formatMessage(msg, channelName, state.activeChannel));
      state.cursors.set(channelName, msg.id);
    }
  }
}

// --- Send Mode ---

export function runSendMode(
  db: Database,
  agentId: string,
  channel: string,
  filePath?: string
): Message {
  if (!filePath && process.stdin.isTTY) {
    throw new Error("Provide -f <path> or pipe content via stdin");
  }
  const content = filePath
    ? readFileSync(filePath, "utf-8")
    : readFileSync(0, "utf-8"); // fd 0 = stdin

  return sendMessage(db, agentId, channel, content);
}

// --- Entry Point ---

async function main() {
  const args = parseArgs(process.argv);
  const db = openDb();

  if (args.mode === "send") {
    const msg = runSendMode(db, args.agentId, args.channel, args.filePath);
    console.log(msg.id);
    process.exit(0);
  }

  // REPL mode — implemented in Task 4
  startRepl(db, args.agentId, args.channel);
}

function startRepl(db: Database, agentId: string, channel: string): void {
  const maxRow = db
    .query(
      `SELECT MAX(m.id) as max_id
       FROM messages m
       JOIN channels ch ON m.channel_id = ch.id
       WHERE ch.name = ?`
    )
    .get(channel) as { max_id: number | null } | null;

  // Ensure channel exists
  createChannel(db, channel, agentId);

  const state: ReplState = {
    activeChannel: channel,
    cursors: new Map([[channel, maxRow?.max_id ?? 0]]),
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  function updatePrompt() {
    rl.setPrompt(`${sanitize(state.activeChannel)}> `);
  }

  function printAbove(text: string) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(text + "\n");
    rl.prompt(true);
  }

  // Background poll
  const intervalMs = Number(process.env.OCTO_SANTA_POLL_INTERVAL_MS) || 1000;
  const pollTimer = setInterval(() => {
    try {
      pollTick(db, agentId, state, printAbove);
    } catch (err) {
      console.error("poll error:", err);
    }
  }, intervalMs);
  pollTimer.unref();

  // Line handler
  rl.on("line", (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    const cmd = parseCommand(trimmed);
    if (cmd) {
      try {
        const keepRunning = handleCommand(cmd, db, agentId, state, printAbove);
        if (!keepRunning) {
          clearInterval(pollTimer);
          rl.close();
          return;
        }
      } catch (err: any) {
        printAbove(`Error: ${err.message}`);
      }
      updatePrompt();
      rl.prompt();
      return;
    }

    // Regular message
    try {
      sendMessage(db, agentId, state.activeChannel, trimmed);
      printAbove(`[${agentId}] ${trimmed}`);
    } catch (err: any) {
      printAbove(`Error: ${err.message}`);
    }
    rl.prompt();
  });

  function shutdown() {
    clearInterval(pollTimer);
    rl.close();
    process.exit(0);
  }

  rl.on("close", shutdown);
  process.on("SIGINT", shutdown);

  console.log(`Joined #${channel} as ${agentId}. Type /help for commands.`);
  updatePrompt();
  rl.prompt();
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
