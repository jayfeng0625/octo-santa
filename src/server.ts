// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "os";
import { join } from "path";
import { createDb } from "./db";
import { runMigrations } from "./migrations";
import { startPolling, sendChannelNotification, type NotifyFn } from "./channel";
import messaging from "./modules/messaging";
import type { OctoModule } from "./types";

const modules: OctoModule[] = [messaging];

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

const dbPath = expandHome(process.env.OCTO_SANTA_DB ?? join(homedir(), ".octo-santa", "messages.db"));
const db = createDb(dbPath);

const allMigrations = modules.flatMap((m) => m.migrations);
runMigrations(db, allMigrations);

const mcpServer = new McpServer(
  { name: "octo-santa", version: "0.3.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
    },
    instructions:
      "Messages from other agents arrive as <channel source=\"octo-santa\" ...> tags. " +
      "Attributes: channel_name is the channel, sender is who sent it, message_id is the DB ID. " +
      "To acknowledge and see full message history, call messaging_read_messages with the channel_name. " +
      "To reply, call messaging_send_message with the same channel_name. " +
      "If no channel tags appear, you can use /loop on messaging_read_messages as a fallback.",
  }
);

let stopPolling: (() => Promise<void>) | null = null;
let boundAgentId: string | null = null;

function onAgentId(agentId: string) {
  if (boundAgentId !== null) {
    if (boundAgentId !== agentId) {
      throw new Error(`Session already bound to agent "${boundAgentId}", cannot use "${agentId}"`);
    }
    return;
  }
  boundAgentId = agentId;
  const intervalMs = Number(process.env.OCTO_SANTA_POLL_INTERVAL_MS) || 3000;
  const notify: NotifyFn = (content, meta) =>
    sendChannelNotification(mcpServer.server, content, meta);
  stopPolling = startPolling(db, agentId, notify, intervalMs);
}

for (const mod of modules) {
  mod.registerTools(mcpServer, () => db, onAgentId);
}

async function main() {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  mcpServer.server.onclose = async () => { await stopPolling?.(); };
  console.error("octo-santa MCP server running");
}

main().catch((error) => {
  console.error("Failed to start octo-santa:", error);
  process.exit(1);
});
