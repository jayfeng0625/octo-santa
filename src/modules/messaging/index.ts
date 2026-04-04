import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { OctoModule } from "../../types";
import {
  messagingMigrations,
  registerAgent,
  createChannel,
  subscribe,
  listChannels,
  sendMessage,
  readMessages,
  directMessage,
  listAgents,
  listChannelMembers,
  unregisterAgent,
  renameChannel,
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

  onDisconnect(db: Database, agentId: string, pid: number) {
    unregisterAgent(db, agentId, pid);
  },

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
      description: "Create a named messaging channel. Use messaging_subscribe to join it afterward.",
      inputSchema: {
        agent_id: z.string().trim().min(1).describe("Your agent/project name"),
        name: z.string().trim().min(1).describe("Channel name"),
      },
    }, async ({ agent_id, name }) => {
      return withAgent(onAgentId, agent_id, () => {
        const channel = createChannel(getDb(), name, agent_id);
        return jsonResult(channel);
      });
    });

    server.registerTool("messaging_subscribe", {
      description: "Subscribe to an existing channel to start receiving notifications.",
      inputSchema: {
        agent_id: z.string().trim().min(1).describe("Your agent/project name"),
        channel: z.string().trim().min(1).describe("Channel name to subscribe to"),
      },
    }, async ({ agent_id, channel }) => {
      return withAgent(onAgentId, agent_id, () => {
        subscribe(getDb(), agent_id, channel);
        return jsonResult({ subscribed: true, channel });
      });
    });

    server.registerTool("messaging_list_channels", {
      description: "List all messaging channels",
    }, async () => {
      return jsonResult(listChannels(getDb()));
    });

    server.registerTool("messaging_send_message", {
      description: "Send a message to a channel. Requires prior messaging_register and an existing channel. Use @agent-name to notify specific agents, or @all to notify everyone. Messages without mentions are silent.",
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
      description: "Read unread messages from a channel (or query history with before_id). Requires prior messaging_register and channel membership.",
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

    server.registerTool("messaging_direct_message", {
      description: "Send a direct message to another agent. Creates a DM channel and subscribes both parties.",
      inputSchema: {
        agent_id: z.string().trim().min(1).describe("Your agent/project name"),
        target_agent_id: z.string().trim().min(1).describe("Agent to DM"),
        content: z.string().trim().min(1).describe("Message content"),
      },
    }, async ({ agent_id, target_agent_id, content }) => {
      return withAgent(onAgentId, agent_id, () =>
        jsonResult(directMessage(getDb(), agent_id, target_agent_id, content))
      );
    });

    server.registerTool("messaging_list_agents", {
      description: "List agents. Defaults to active agents only. Use include_stale to see all agents including disconnected ones.",
      inputSchema: {
        include_stale: z.boolean().optional().default(false).describe("If true, include stale/disconnected agents (default: active only)"),
      },
    }, async ({ include_stale }) => {
      return jsonResult(listAgents(getDb(), include_stale));
    });

    server.registerTool("messaging_list_members", {
      description: "List channel members with active/inactive status. Uses exact process liveness — may temporarily differ from push notification behavior after crashes.",
      inputSchema: {
        channel: z.string().trim().min(1).describe("Channel name"),
      },
    }, async ({ channel }) => {
      return jsonResult(listChannelMembers(getDb(), channel));
    });

    server.registerTool("messaging_rename_channel", {
      description: "Rename a channel. You must be a member of the channel.",
      inputSchema: {
        agent_id: z.string().trim().min(1).describe("Your agent/project name"),
        channel: z.string().trim().min(1).describe("Current channel name"),
        new_name: z.string().trim().min(1).describe("New channel name"),
      },
    }, async ({ agent_id, channel, new_name }) => {
      return withAgent(onAgentId, agent_id, () =>
        jsonResult(renameChannel(getDb(), agent_id, channel, new_name))
      );
    });
  },
};

export default messaging;
