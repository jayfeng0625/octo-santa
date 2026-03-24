// src/mcp.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startPolling, sendChannelNotification, type NotifyFn } from "./channel";
import { openDb, modules } from "./bootstrap";

const db = openDb();

const mcpServer = new McpServer(
  { name: "octo-santa", version: "0.3.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
    },
    instructions:
      'octo-santa messaging module is available. Call messaging_register with a ' +
      'unique agent name (e.g. your role), then read or send on a channel to ' +
      'start receiving push notifications. If the name is taken, pick a different one.\n\n' +
      'Messages from other agents arrive as <channel source="octo-santa" ...> tags. ' +
      'To acknowledge and see full history, call messaging_read_messages with the channel_name. ' +
      'To reply, call messaging_send_message with the same channel_name.\n\n' +
      'CHANNELS: Messages live in named channels. Use messaging_send_message to send and ' +
      'messaging_read_messages to read. Channels are created on first use.\n\n' +
      'MENTIONS:\n' +
      '- @agent-name → only that agent gets notified\n' +
      '- @all → all channel subscribers get notified\n' +
      '- No mention → message is silent (recipients must read actively)\n\n' +
      'Use @mentions to get attention. Messages without mentions are for ' +
      'context/logging — recipients see them when they check the channel.\n\n' +
      'DISCOVERY: Use messaging_list_agents to see registered agents.',
  }
);

let stopPolling: (() => Promise<void>) | null = null;
let boundAgentId: string | null = null;

function onAgentId(agentId: string): { commit: () => void } {
  if (boundAgentId !== null) {
    if (boundAgentId !== agentId) {
      throw new Error(`Session already bound to agent "${boundAgentId}", cannot use "${agentId}"`);
    }
    return { commit: () => {} };
  }
  // Deferred binding — caller must commit() after successful operation
  return {
    commit: () => {
      if (boundAgentId !== null) return; // Already bound (concurrent commit)
      boundAgentId = agentId;
      const intervalMs = Number(process.env.OCTO_SANTA_POLL_INTERVAL_MS) || 3000;
      const notify: NotifyFn = (content, meta) =>
        sendChannelNotification(mcpServer.server, content, meta);
      stopPolling = startPolling(db, agentId, notify, intervalMs);
    },
  };
}

for (const mod of modules) {
  mod.registerTools(mcpServer, () => db, onAgentId);
}

async function main() {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  mcpServer.server.onclose = async () => { await stopPolling?.(); };

  // Bootstrap nudge — prompt agent to register before any tool call
  await sendChannelNotification(mcpServer.server,
    "octo-santa messaging module is available. Call messaging_register with a unique agent name, then read or send on a channel to start receiving push notifications.",
    { type: "bootstrap" }
  );

  console.error("octo-santa MCP server running");
}

main().catch((error) => {
  console.error("Failed to start octo-santa:", error);
  process.exit(1);
});
