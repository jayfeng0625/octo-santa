// src/transports/repl/app.ts
import type { MessagingService } from "../../core/messaging/service";
import type { ChannelRepository } from "../../core/ports";
import { InputBuffer } from "./buffer";
import { KeyParser, type Action } from "./keys";
import { Renderer, formatMessage } from "./renderer";
import { parseCommand, executeCommand, type ReplState } from "./commands";

export interface AppOptions {
  svc: MessagingService;
  channelRepo: ChannelRepository;
  agentId: string;
  channel: string;
  pollIntervalMs: number;
  kittyEnabled: boolean;
}

export function startApp(opts: AppOptions): () => void {
  const { svc, channelRepo, agentId, channel, pollIntervalMs } = opts;

  const buffer = new InputBuffer();
  const parser = new KeyParser({ kittyEnabled: opts.kittyEnabled });
  const renderer = new Renderer();

  const state: ReplState = {
    activeChannel: channel,
    joinedChannels: new Set([channel]),
    cursors: new Map(),
    agentId,
  };

  // Init cursor from the DB PULL read cursor (preserves unread backlog on reconnect). The REPL
  // is a pull reader (pollNewMessages) — it must NOT read the push delivery cursor (I10/F4).
  state.cursors.set(channel, svc.getReadCursor(agentId, channel));

  function getPrompt(): string {
    return `${state.activeChannel}> `;
  }

  // Enable raw mode
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  // Enable Kitty protocol
  if (opts.kittyEnabled) {
    process.stdout.write("\x1b[>1u");
  }
  // Enable bracketed paste
  process.stdout.write("\x1b[?2004h");

  // Initial render
  renderer.renderInput(getPrompt(), buffer);

  // Handle resize
  renderer.setResizeHandler(() => {
    renderer.renderInput(getPrompt(), buffer);
  });

  // Stdin handler
  function onData(data: Buffer) {
    const actions = parser.parse(data);
    for (const action of actions) {
      handleAction(action);
    }
  }

  function handleAction(action: Action) {
    switch (action.type) {
      case "insert":
        buffer.insert(action.text);
        renderer.renderInput(getPrompt(), buffer);
        break;
      case "submit": {
        const text = buffer.submit();
        if (!text.trim()) {
          renderer.renderInput(getPrompt(), buffer);
          break;
        }

        // Command detection: single-line + known command
        if (!text.includes("\n")) {
          const cmd = parseCommand(text);
          if (cmd) {
            try {
              const result = executeCommand(cmd, svc, channelRepo, state);
              if (result.channelChange) {
                state.activeChannel = result.channelChange;
              }
              if (result.exit) {
                cleanup();
                process.exit(0);
              }
              // Render local echo if command sent a message (e.g. /send -f)
              if (result.localEcho) {
                const formatted = formatMessage(
                  result.localEcho,
                  state.activeChannel,
                  state.activeChannel,
                );
                renderer.printMessage(formatted, getPrompt(), buffer);
              } else if (result.messages) {
                for (const msg of result.messages) {
                  const formatted = formatMessage(msg, state.activeChannel, state.activeChannel);
                  renderer.printMessage(formatted, getPrompt(), buffer);
                }
              } else if (result.output.length > 0) {
                renderer.printOutput(result.output.join("\n"), getPrompt(), buffer);
              } else {
                renderer.renderInput(getPrompt(), buffer);
              }
            } catch (err) {
              renderer.printError((err as Error).message, getPrompt(), buffer);
            }
            break;
          }
        }

        // Send message
        try {
          svc.send(agentId, state.activeChannel, text, { human: true });
          // Local echo
          const formatted = formatMessage(
            { agent_id: agentId, content: text },
            state.activeChannel,
            state.activeChannel,
          );
          renderer.printMessage(formatted, getPrompt(), buffer);
        } catch (err) {
          renderer.printError((err as Error).message, getPrompt(), buffer);
        }
        break;
      }
      case "exit":
        cleanup();
        process.exit(0);
        break;
      case "backspace":
        buffer.backspace();
        renderer.renderInput(getPrompt(), buffer);
        break;
      case "delete":
        buffer.delete();
        renderer.renderInput(getPrompt(), buffer);
        break;
      case "deleteWord":
        buffer.deleteWord();
        renderer.renderInput(getPrompt(), buffer);
        break;
      case "deleteToEnd":
        buffer.deleteToEnd();
        renderer.renderInput(getPrompt(), buffer);
        break;
      case "deleteToStart":
        buffer.deleteToStart();
        renderer.renderInput(getPrompt(), buffer);
        break;
      case "move":
        buffer.move(action.dir);
        renderer.renderInput(getPrompt(), buffer);
        break;
    }
  }

  process.stdin.on("data", onData);

  // Poll loop — uses service instead of raw SQL
  const pollTimer = setInterval(() => {
    for (const channelName of state.joinedChannels) {
      const cursor = state.cursors.get(channelName) ?? 0;
      const rows = svc.pollNewMessages(channelName, cursor, agentId, 50);

      if (rows.length === 0) continue;

      for (const row of rows) {
        const formatted = formatMessage(
          { agent_id: row.agent_id, content: row.content },
          channelName,
          state.activeChannel,
        );
        renderer.printMessage(formatted, getPrompt(), buffer);
      }

      // Advance cursor to max polled ID
      const maxId = rows[rows.length - 1]!.id;
      state.cursors.set(channelName, maxId);
    }
  }, pollIntervalMs);
  pollTimer.unref();

  function cleanup() {
    clearInterval(pollTimer);
    process.stdin.removeListener("data", onData);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    // Disable bracketed paste
    process.stdout.write("\x1b[?2004l");
    // Disable Kitty protocol
    if (opts.kittyEnabled) {
      process.stdout.write("\x1b[<u");
    }
    process.stdout.write("\n");
    parser.destroy();
    renderer.destroy();
  }

  return cleanup;
}
