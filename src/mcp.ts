// src/mcp.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startPolling, sendChannelNotification, type NotifyFn } from "./channel";
import { openDb, modules, log } from "./bootstrap";
import { readConfig, scanBrainDocs } from "./modules/brain/tools";

const db = openDb();

function buildInstructions(): string {
  let instructions =
    'octo-santa messaging module is available. Call messaging_register with a ' +
    'unique agent name (e.g. your role). If the name is taken, pick a different one.\n\n' +
    'You must call messaging_register before sending, reading, creating channels, or subscribing. ' +
    'Read-only tools (messaging_list_channels, messaging_list_agents, messaging_list_members) work without registration.\n\n' +
    'Messages from other agents arrive as <channel source="octo-santa" ...> tags. ' +
    'To acknowledge and see full history, call messaging_read_messages with the channel. ' +
    'To reply, call messaging_send_message with the same channel.\n\n' +
    'CHANNELS: Messages live in named channels. Create channels with messaging_create_channel, ' +
    'then subscribe with messaging_subscribe to receive notifications. ' +
    'Channels must exist before sending — use messaging_create_channel to create them.\n\n' +
    'MENTIONS:\n' +
    '- @agent-name → only that agent gets notified\n' +
    '- @all → all channel subscribers get notified\n' +
    '- No mention → message is silent (recipients must read actively)\n\n' +
    'Use @mentions to get attention. Messages without mentions are for ' +
    'context/logging — recipients see them when they check the channel.\n\n' +
    'NOTIFICATIONS: There are two notification modes:\n' +
    '- DM channels (created via messaging_direct_message): All messages push automatically to both parties. No @mention needed.\n' +
    '- Regular channels (created via messaging_create_channel): Only messages with @mentions trigger push notifications. Unmentioned messages are silent.\n\n' +
    'To ensure an agent sees your message immediately, either use @agent-name in a regular channel or use messaging_direct_message for 1:1 conversations.\n\n' +
    'DISCOVERY: Use messaging_list_agents to see currently online agents. ' +
    'Use messaging_list_agents with include_stale=true to see all agents including disconnected ones. ' +
    'Use messaging_list_members to see who is in a specific channel.';

  const config = readConfig(process.cwd());

  instructions += '\n\n' +
    'BRAIN: ';
  if (config?.domain) {
    instructions += `This repo is domain "${config.domain.identifier}" (${config.domain.description}). `;
  }
  instructions +=
    'Use brain_index to list local brain docs, brain_read to read one. ' +
    'Use brain_shared_index/brain_shared_read for shared docs in ~/.octo-santa/brain/. ' +
    'Use brain_find_expert to discover domain experts across repos. ' +
    'Use brain_claim_domain after messaging_register to become a queryable expert. ' +
    'Use messaging_direct_message to DM another agent.';

  return instructions;
}

const mcpServer = new McpServer(
  { name: "octo-santa", version: "0.3.1" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
    },
    instructions: buildInstructions(),
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
  mcpServer.server.onclose = async () => {
    try {
      await stopPolling?.();
    } finally {
      if (boundAgentId) {
        for (const mod of modules) {
          mod.onDisconnect?.(db, boundAgentId, process.pid);
        }
      }
    }
  };

  // Bootstrap nudge — prompt agent to register before any tool call
  const config = readConfig(process.cwd());
  let bootstrapMsg = "octo-santa messaging module is available. Call messaging_register with a unique agent name (e.g. your role), then create or subscribe to channels to start receiving push notifications. If the name is taken, pick a different one.";
  if (config?.domain) {
    bootstrapMsg += `\n\nBrain module active — this repo is domain "${config.domain.identifier}" (${config.domain.description}). ` +
      "After messaging_register, call brain_claim_domain to become a queryable expert.";
  }
  if (config?.brain?.dirs || config?.brain?.files) {
    const brainDocs = scanBrainDocs(process.cwd(), config.brain?.dirs, config.brain?.files);
    if (brainDocs.length > 0) {
      const index = brainDocs.map(d => `- [${d.path}](${d.slug}) — ${d.summary}`).join("\n");
      bootstrapMsg += `\n\nBrain index:\n${index}`;
    }
  }
  await sendChannelNotification(mcpServer.server, bootstrapMsg, { type: "bootstrap" });

  log("octo-santa MCP server running");
}

main().catch((error) => {
  log(`Failed to start octo-santa: ${error}`);
  process.exit(1);
});
