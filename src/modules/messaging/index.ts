import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { OctoModule } from "../../types";
import {
  messagingMigrations,
  registerAgent,
  createChannel,
  listChannels,
  sendMessage,
  readMessages,
  listAgents,
} from "./tools";

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function withAgent<T>(
  onAgentId: ((agentId: string) => { commit: () => void }) | undefined,
  agentId: string,
  fn: () => T
): T {
  const handle = onAgentId?.(agentId); // Phase 1: guard check (throws if mismatched)
  const result = fn();
  handle?.commit(); // Phase 2: bind session (only on success)
  return result;
}

const messaging: OctoModule = {
  name: "messaging",
  migrations: messagingMigrations,

  registerTools(server: McpServer, getDb: () => Database, onAgentId?: (agentId: string) => { commit: () => void }) {
    server.registerTool("messaging_register", {
      description: "Register this agent with a unique name to start receiving messages",
      inputSchema: { agent_id: z.string().trim().min(1).regex(/^[\w-]+$/, "Must be letters, digits, underscores, or hyphens").describe("Your agent/project name") },
    }, async ({ agent_id }) => {
      return withAgent(onAgentId, agent_id, () =>
        jsonResult(registerAgent(getDb(), agent_id))
      );
    });

    server.registerTool("messaging_create_channel", {
      description: "Create a named messaging channel",
      inputSchema: {
        agent_id: z.string().trim().min(1).describe("Your agent/project name"),
        name: z.string().trim().min(1).describe("Channel name"),
      },
    }, async ({ agent_id, name }) => {
      return withAgent(onAgentId, agent_id, () =>
        jsonResult(createChannel(getDb(), name, agent_id))
      );
    });

    server.registerTool("messaging_list_channels", {
      description: "List all messaging channels",
    }, async () => {
      return jsonResult(listChannels(getDb()));
    });

    server.registerTool("messaging_send_message", {
      description: "Send a message to a channel. Use @agent-name to notify specific agents, or @all to notify everyone. Messages without mentions are silent.",
      inputSchema: {
        agent_id: z.string().trim().min(1).describe("Your agent/project name"),
        channel: z.string().trim().min(1).describe("Channel name"),
        content: z.string().trim().min(1).describe("Message content"),
      },
    }, async ({ agent_id, channel, content }) => {
      return withAgent(onAgentId, agent_id, () =>
        jsonResult(sendMessage(getDb(), agent_id, channel, content))
      );
    });

    server.registerTool("messaging_read_messages", {
      description: "Read unread messages from a channel (or query history with before_id)",
      inputSchema: {
        agent_id: z.string().trim().min(1).describe("Your agent/project name"),
        channel: z.string().trim().min(1).describe("Channel name"),
        limit: z.number().int().positive().optional().describe("Max messages to return"),
        before_id: z.number().int().positive().optional().describe("Get messages before this ID (history mode, does not advance cursor)"),
      },
    }, async ({ agent_id, channel, limit, before_id }) => {
      return withAgent(onAgentId, agent_id, () =>
        jsonResult(readMessages(getDb(), agent_id, channel, { limit, before_id }))
      );
    });

    server.registerTool("messaging_list_agents", {
      description: "List all registered agents",
    }, async () => {
      return jsonResult(listAgents(getDb()));
    });
  },
};

export default messaging;
