// src/repl.ts

import { readFileSync } from "node:fs";
import * as readline from "node:readline";
import { PassThrough } from "node:stream";
import type { Database } from "bun:sqlite";
import {
  createChannel,
  listChannels,
  sendMessage,
  readMessages,
  listAgents,
  listChannelMembers,
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

// --- Paste Support ---

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const BRACKETED_PASTE_ENABLE = "\x1b[?2004h";
const BRACKETED_PASTE_DISABLE = "\x1b[?2004l";

/**
 * PassThrough stream that intercepts bracketed paste escape sequences
 * from process.stdin before readline sees them. Buffers content during
 * paste and pushes it on paste end — push() is synchronous, so readline's
 * line events fire while isPasting is still true.
 */
export class PasteAwareStream extends PassThrough {
  readonly isTTY: boolean;
  isPasting = false;
  pasteSeen = false;
  private readonly source: NodeJS.ReadStream;
  private _pasteBuffer = "";
  private _onData: (chunk: Buffer | string) => void;
  private _onEnd: () => void;
  private _onError: (err: Error) => void;
  private _discarding = false;

  constructor(source: NodeJS.ReadStream) {
    super();
    this.source = source;
    this.isTTY = (source as any).isTTY ?? false;

    this._onData = (chunk: Buffer | string) => {
      const str = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      let remaining = str;

      while (remaining.length > 0) {
        // Discard mode: swallow everything until PASTE_END after a mid-paste cancel
        if (this._discarding) {
          const endIdx = remaining.indexOf(PASTE_END);
          if (endIdx !== -1) {
            remaining = remaining.slice(endIdx + PASTE_END.length);
            this._discarding = false;
          } else {
            remaining = "";
          }
          continue;
        }

        if (this.isPasting) {
          const endIdx = remaining.indexOf(PASTE_END);
          if (endIdx !== -1) {
            this._pasteBuffer += remaining.slice(0, endIdx);
            remaining = remaining.slice(endIdx + PASTE_END.length);
            // Push buffered content — isPasting is still true during push,
            // so readline line events fire with isPasting === true
            if (this._pasteBuffer) {
              this.push(Buffer.from(this._pasteBuffer, "utf-8"));
            }
            this._pasteBuffer = "";
            this.isPasting = false;
          } else {
            this._pasteBuffer += remaining;
            remaining = "";
          }
        } else {
          const startIdx = remaining.indexOf(PASTE_START);
          if (startIdx !== -1) {
            if (startIdx > 0) {
              this.push(Buffer.from(remaining.slice(0, startIdx), "utf-8"));
            }
            remaining = remaining.slice(startIdx + PASTE_START.length);
            this.isPasting = true;
            this.pasteSeen = true;
            this._pasteBuffer = "";
          } else {
            this.push(Buffer.from(remaining, "utf-8"));
            remaining = "";
          }
        }
      }
    };

    this._onEnd = () => this.push(null);
    this._onError = (err: Error) => this.destroy(err);

    source.on("data", this._onData);
    source.on("end", this._onEnd);
    source.on("error", this._onError);
  }

  setRawMode(mode: boolean): this {
    if (typeof (this.source as any).setRawMode === "function") {
      (this.source as any).setRawMode(mode);
    }
    return this;
  }

  ref(): this {
    if (typeof this.source.ref === "function") {
      this.source.ref();
    }
    return this;
  }

  unref(): this {
    if (typeof this.source.unref === "function") {
      this.source.unref();
    }
    return this;
  }

  /**
   * Reset all paste state. Used by SIGINT handler to cleanly abort a paste.
   * If called during an active multi-chunk paste, enters _discarding mode
   * which swallows all data until the closing PASTE_END marker arrives.
   */
  reset(): void {
    if (this.isPasting) {
      this._discarding = true; // swallow until PASTE_END
    }
    this.isPasting = false;
    this.pasteSeen = false;
    this._pasteBuffer = "";
  }

  override _destroy(err: Error | null, callback: (error?: Error | null) => void): void {
    this.source.removeListener("data", this._onData);
    this.source.removeListener("end", this._onEnd);
    this.source.removeListener("error", this._onError);
    super._destroy(err, callback);
  }
}

export type LineAction =
  | { action: "buffer" }
  | { action: "send"; content: string }
  | { action: "passthrough"; line: string };

/**
 * Decide what to do with a readline line event given paste state.
 * Mutates stream.pasteSeen and pasteBuffer.
 */
export function handleLine(
  stream: { isPasting: boolean; pasteSeen: boolean },
  pasteBuffer: string[],
  line: string
): LineAction {
  if (stream.isPasting) {
    pasteBuffer.push(line);
    return { action: "buffer" };
  }
  if (stream.pasteSeen) {
    if (line) pasteBuffer.push(line);
    const content = pasteBuffer.join("\n");
    pasteBuffer.length = 0;
    stream.pasteSeen = false;
    // Empty paste (no content and no confirming line) → treat as no-op
    if (!content) return { action: "passthrough", line };
    return { action: "send", content };
  }
  return { action: "passthrough", line };
}

/**
 * Handle Ctrl+C with paste awareness. Returns true if a paste was
 * discarded (caller should clear line and redraw prompt), false if
 * no paste was active (caller should exit).
 *
 * When stream is a PasteAwareStream, also calls reset() to clear
 * internal paste buffer and isPasting flag.
 */
export function handleSigint(
  stream: { isPasting: boolean; pasteSeen: boolean; reset?: () => void },
  pasteBuffer: string[]
): boolean {
  if (stream.pasteSeen || stream.isPasting) {
    pasteBuffer.length = 0;
    stream.pasteSeen = false;
    stream.reset?.(); // clears isPasting and internal buffer on real stream
    return true;
  }
  return false;
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
    case "members": {
      const members = listChannelMembers(db, state.activeChannel);
      if (members.length === 0) {
        print("No members in this channel");
      } else {
        const lines = members.map(
          (m) => `  ${sanitize(m.agent_id)} ${m.active ? "(active)" : "(inactive)"}`
        );
        print(lines.join("\n"));
      }
      return true;
    }
    case "help": {
      print(
        [
          "Commands:",
          "  /channels         List all channels",
          "  /agents           List all registered agents",
          "  /members          List channel members (agents appear after sending/reading)",
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

  // --- Bracketed paste mode ---
  const isTTY = !!(process.stdin.isTTY && process.stdout.isTTY);
  const pasteStream = isTTY
    ? new PasteAwareStream(process.stdin as unknown as NodeJS.ReadStream)
    : undefined;
  const pasteBuffer: string[] = [];

  if (isTTY) {
    process.stdout.write(BRACKETED_PASTE_ENABLE);
  }

  const rl = readline.createInterface({
    input: pasteStream ?? process.stdin,
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

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (isTTY) process.stdout.write(BRACKETED_PASTE_DISABLE);
    clearInterval(pollTimer);
    pasteStream?.destroy();
    rl.close();
    process.exit(0);
  }

  rl.on("close", shutdown);
  rl.on("SIGINT", () => {
    const stream = pasteStream ?? { isPasting: false, pasteSeen: false };
    if (handleSigint(stream, pasteBuffer)) {
      rl.write(null, { ctrl: true, name: "u" }); // clear current line
      rl.prompt();
      return;
    }
    shutdown();
  });

  // Line handler
  rl.on("line", (input: string) => {
    const stream = pasteStream ?? { isPasting: false, pasteSeen: false };
    const action = handleLine(stream, pasteBuffer, input);

    if (action.action === "buffer") {
      return; // still pasting — don't send, don't prompt
    }

    if (action.action === "send") {
      // Paste complete — send as single message, preserving whitespace
      try {
        sendMessage(db, agentId, state.activeChannel, action.content);
        printAbove(`[${agentId}] ${sanitize(action.content)}`);
      } catch (err: any) {
        printAbove(`Error: ${err.message}`);
      }
      rl.prompt();
      return;
    }

    // action.action === "passthrough" — existing behavior
    const trimmed = action.line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    const cmd = parseCommand(trimmed);
    if (cmd) {
      try {
        const keepRunning = handleCommand(cmd, db, agentId, state, printAbove);
        if (!keepRunning) {
          shutdown();
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
