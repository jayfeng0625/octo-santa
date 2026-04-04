import type { Database } from "bun:sqlite";
import { registerAgent, createChannel, subscribe } from "../modules/messaging/tools";

export function startupRepl(db: Database, agentId: string, channel: string): void {
  registerAgent(db, agentId);
  createChannel(db, channel, agentId);
  subscribe(db, agentId, channel);
}
