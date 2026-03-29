// src/repl/app.tsx

import React, { useState, useEffect, useCallback } from "react";
import { Box, useApp } from "ink";
import type { Database } from "bun:sqlite";
import { sendMessage, createChannel } from "../modules/messaging/tools";
import { parseCommand, handleCommand } from "./commands";
import { pollTick, type PollState } from "./poll";
import { sanitize, formatMessage } from "./display";
import { MessageLog, type LogEntry } from "./components/message-log";
import { TextInput } from "./components/text-input";

// Kitty keyboard protocol enable/disable sequences
const KITTY_ENABLE = "\x1b[>1u";
const KITTY_DISABLE = "\x1b[<u";

export interface AppProps {
  db: Database;
  agentId: string;
  initialChannel: string;
  pollIntervalMs?: number;
}

export function App({ db, agentId, initialChannel, pollIntervalMs = 1000 }: AppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<LogEntry[]>([
    { text: `Joined #${initialChannel} as ${agentId}. Type /help for commands.`, system: true },
  ]);
  const [activeChannel, setActiveChannel] = useState(initialChannel);
  const [cursors] = useState(() => {
    createChannel(db, initialChannel, agentId);
    const maxRow = db
      .query(
        `SELECT MAX(m.id) as max_id
         FROM messages m
         JOIN channels ch ON m.channel_id = ch.id
         WHERE ch.name = ?`
      )
      .get(initialChannel) as { max_id: number | null } | null;
    return new Map([[initialChannel, maxRow?.max_id ?? 0]]);
  });

  // Enable Kitty keyboard protocol on mount, disable on unmount
  useEffect(() => {
    if (process.stdout.isTTY) {
      process.stdout.write(KITTY_ENABLE);
      return () => {
        process.stdout.write(KITTY_DISABLE);
      };
    }
  }, []);

  // Poll for new messages
  useEffect(() => {
    const timer = setInterval(() => {
      try {
        const state: PollState = { activeChannel, cursors };
        const newMsgs = pollTick(db, agentId, state);
        if (newMsgs.length > 0) {
          setMessages((prev) => [
            ...prev,
            ...newMsgs.map((m) => ({
              text: formatMessage(
                { agent_id: m.agent, content: m.content },
                m.channel,
                activeChannel
              ),
            })),
          ]);
        }
      } catch {
        // Poll error — silently retry next tick
      }
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [db, agentId, activeChannel, pollIntervalMs]);

  const handleSubmit = useCallback(
    (input: string) => {
      const cmd = parseCommand(input);
      if (cmd) {
        const result = handleCommand(cmd, db, agentId, activeChannel, cursors);
        if (result.quit) {
          exit();
          return;
        }
        if (result.channelChange) {
          setActiveChannel(result.channelChange);
        }
        if (result.output.length > 0) {
          setMessages((prev) => [
            ...prev,
            ...result.output.map((text) => ({ text, system: true })),
          ]);
        }
        return;
      }

      // Regular message
      try {
        sendMessage(db, agentId, activeChannel, input);
        setMessages((prev) => [
          ...prev,
          { text: `[${agentId}] ${sanitize(input)}` },
        ]);
      } catch (err: any) {
        setMessages((prev) => [
          ...prev,
          { text: `Error: ${err.message}`, system: true },
        ]);
      }
    },
    [db, agentId, activeChannel, cursors, exit]
  );

  return (
    <Box flexDirection="column">
      <MessageLog messages={messages} />
      <TextInput prompt={activeChannel} onSubmit={handleSubmit} onExit={exit} />
    </Box>
  );
}
