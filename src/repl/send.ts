// src/repl/send.ts

import { readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { sendMessage } from "../modules/messaging/tools";
import type { Message } from "../modules/messaging/types";

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
