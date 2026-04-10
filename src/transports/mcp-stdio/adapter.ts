// src/transports/mcp-stdio/adapter.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { MessagingService } from "../../core/messaging/service";
import type { BrainService } from "../../core/brain/service";
import type { OctoSantaConfig, BrainDoc } from "../../core/brain/types";
import type { NotificationPort, AgentRepository } from "../../core/ports";
import { log } from "../../log";
import { jsonResult, withAgent } from "./helpers";

// --- Instructions builder ---

export function buildInstructions(
  config: OctoSantaConfig | null,
  brainIndex?: BrainDoc[]
): string {
  let instructions =
    "octo-santa messaging module is available. Call messaging_register with a " +
    "unique agent name (e.g. your role). If the name is taken, pick a different one.\n\n" +
    "You must call messaging_register before sending, reading, creating channels, or subscribing. " +
    "Read-only tools (messaging_list_channels, messaging_list_agents, messaging_list_members) work without registration.\n\n" +
    "Messages from other agents arrive as <channel source=\"octo-santa\" ...> tags. " +
    "To acknowledge and see full history, call messaging_read_messages with the channel. " +
    "To reply, call messaging_send_message with the same channel.\n\n" +
    "CHANNELS: Messages live in named channels. Create channels with messaging_create_channel, " +
    "then subscribe with messaging_subscribe to receive notifications. " +
    "Channels must exist before sending — use messaging_create_channel to create them.\n\n" +
    "MENTIONS:\n" +
    "- @agent-name → only that agent gets notified\n" +
    "- @all → all channel subscribers get notified\n" +
    "- No mention → message is silent (recipients must read actively)\n\n" +
    "Use @mentions to get attention. Messages without mentions are for " +
    "context/logging — recipients see them when they check the channel.\n\n" +
    "NOTIFICATIONS: There are two notification modes:\n" +
    "- DM channels (created via messaging_direct_message): All messages push automatically to both parties. No @mention needed.\n" +
    "- Regular channels (created via messaging_create_channel): Only messages with @mentions trigger push notifications. Unmentioned messages are silent.\n\n" +
    "To ensure an agent sees your message immediately, either use @agent-name in a regular channel or use messaging_direct_message for 1:1 conversations.\n\n" +
    "DISCOVERY: Use messaging_list_agents to see currently online agents. " +
    "Use messaging_list_agents with include_stale=true to see all agents including disconnected ones. " +
    "Use messaging_list_members to see who is in a specific channel.";

  instructions += "\n\n" + "BRAIN: ";
  if (config?.domain) {
    instructions += `This repo is domain "${config.domain.identifier}" (${config.domain.description}). `;
  }
  instructions +=
    "Use brain_index to list local brain docs, brain_read to read one. " +
    "Use brain_shared_index/brain_shared_read for shared docs in ~/.octo-santa/brain/. " +
    "Use brain_find_expert to discover domain experts across repos. " +
    "Use brain_claim_domain after messaging_register to become a queryable expert. " +
    "Use messaging_direct_message to DM another agent.";

  return instructions;
}

// --- Tool registration ---

export function registerMessagingTools(
  server: McpServer,
  messaging: MessagingService,
  onAgentId?: (agentId: string) => { commit: () => void }
): void {
  server.registerTool("messaging_register", {
    description:
      "Register this agent with a unique name to start receiving messages",
    inputSchema: {
      agent_id: z
        .string()
        .trim()
        .min(1)
        .regex(
          /^[\w-]+$/,
          "Must be letters, digits, underscores, or hyphens"
        )
        .describe("Your agent/project name"),
    },
  }, async ({ agent_id }) => {
    return withAgent(onAgentId, agent_id, () =>
      jsonResult(messaging.register(agent_id))
    );
  });

  server.registerTool("messaging_create_channel", {
    description:
      "Create a named messaging channel. Use messaging_subscribe to join it afterward.",
    inputSchema: {
      agent_id: z.string().trim().min(1).describe("Your agent/project name"),
      name: z.string().trim().min(1).describe("Channel name"),
    },
  }, async ({ agent_id, name }) => {
    return withAgent(onAgentId, agent_id, () => {
      const channel = messaging.createChannel(agent_id, name);
      return jsonResult(channel);
    });
  });

  server.registerTool("messaging_subscribe", {
    description:
      "Subscribe to an existing channel to start receiving notifications.",
    inputSchema: {
      agent_id: z.string().trim().min(1).describe("Your agent/project name"),
      channel: z
        .string()
        .trim()
        .min(1)
        .describe("Channel name to subscribe to"),
    },
  }, async ({ agent_id, channel }) => {
    return withAgent(onAgentId, agent_id, () => {
      messaging.subscribe(agent_id, channel);
      return jsonResult({ subscribed: true, channel });
    });
  });

  server.registerTool("messaging_list_channels", {
    description: "List all messaging channels",
  }, async () => {
    return jsonResult(messaging.listChannels());
  });

  server.registerTool("messaging_send_message", {
    description:
      "Send a message to an existing channel. Requires prior messaging_register. Use @agent-name to notify specific agents, or @all to notify everyone. Messages without mentions are silent — recipients see them only when they check the channel.",
    inputSchema: {
      agent_id: z.string().trim().min(1).describe("Your agent/project name"),
      channel: z.string().trim().min(1).describe("Channel name"),
      content: z.string().trim().min(1).describe("Message content"),
    },
  }, async ({ agent_id, channel, content }) => {
    return withAgent(onAgentId, agent_id, () =>
      jsonResult(messaging.send(agent_id, channel, content))
    );
  });

  server.registerTool("messaging_read_messages", {
    description:
      "Read unread messages from a channel (or query history with before_id). Requires prior messaging_register and channel membership.",
    inputSchema: {
      agent_id: z.string().trim().min(1).describe("Your agent/project name"),
      channel: z.string().trim().min(1).describe("Channel name"),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max messages to return"),
      before_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Get messages before this ID (history mode, does not advance cursor)"
        ),
    },
  }, async ({ agent_id, channel, limit, before_id }) => {
    return withAgent(onAgentId, agent_id, () =>
      jsonResult(messaging.read(agent_id, channel, { limit, before_id }))
    );
  });

  server.registerTool("messaging_direct_message", {
    description:
      "Send a direct message to another agent. Creates a DM channel and subscribes both parties. DM channels push all messages automatically — no @mention needed.",
    inputSchema: {
      agent_id: z.string().trim().min(1).describe("Your agent/project name"),
      target_agent_id: z
        .string()
        .trim()
        .min(1)
        .describe("Agent to DM"),
      content: z.string().trim().min(1).describe("Message content"),
    },
  }, async ({ agent_id, target_agent_id, content }) => {
    return withAgent(onAgentId, agent_id, () =>
      jsonResult(messaging.directMessage(agent_id, target_agent_id, content))
    );
  });

  server.registerTool("messaging_list_agents", {
    description:
      "List agents. Defaults to active agents only. Use include_stale to see all agents including disconnected ones.",
    inputSchema: {
      include_stale: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, include stale/disconnected agents (default: active only)"
        ),
    },
  }, async ({ include_stale }) => {
    return jsonResult(messaging.listAgents(include_stale));
  });

  server.registerTool("messaging_list_members", {
    description:
      "List channel members with active/inactive status. Uses exact process liveness — may temporarily differ from push notification behavior after crashes.",
    inputSchema: {
      channel: z.string().trim().min(1).describe("Channel name"),
    },
  }, async ({ channel }) => {
    return jsonResult(messaging.listMembers(channel));
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
      jsonResult(messaging.renameChannel(agent_id, channel, new_name))
    );
  });
}

export function registerBrainTools(
  server: McpServer,
  brain: BrainService,
  config: OctoSantaConfig | null,
  hasBrain: boolean,
  onAgentId?: (agentId: string) => { commit: () => void }
): void {
  server.registerTool("brain_index", {
    description:
      "List brain documents for this repo (from .octo-santa/config.json brain.dirs and brain.files)",
  }, async () => {
    if (!hasBrain) return { content: [{ type: "text" as const, text: "" }] };
    const docs = brain.index();
    if (docs.length === 0) return { content: [{ type: "text" as const, text: "" }] };
    const index = docs
      .map((d) => `- [${d.path}](${d.slug}) — ${d.summary}`)
      .join("\n");
    return { content: [{ type: "text" as const, text: index }] };
  });

  server.registerTool("brain_read", {
    description: "Read a brain document by slug",
    inputSchema: {
      slug: z
        .string()
        .trim()
        .min(1)
        .describe("Document slug (filename without .md)"),
    },
  }, async ({ slug }) => {
    if (!hasBrain) throw new Error("No brain configured");
    const content = brain.read(slug);
    return { content: [{ type: "text" as const, text: content }] };
  });

  server.registerTool("brain_shared_index", {
    description: "List shared brain documents from ~/.octo-santa/brain/",
  }, async () => {
    const docs = brain.sharedIndex();
    if (docs.length === 0) return { content: [{ type: "text" as const, text: "" }] };
    const index = docs
      .map((d) => `- [${d.path}](${d.slug}) — ${d.summary}`)
      .join("\n");
    return { content: [{ type: "text" as const, text: index }] };
  });

  server.registerTool("brain_shared_read", {
    description: "Read a shared brain document by slug",
    inputSchema: {
      slug: z
        .string()
        .trim()
        .min(1)
        .describe("Document slug (filename without .md)"),
    },
  }, async ({ slug }) => {
    const content = brain.sharedRead(slug);
    return { content: [{ type: "text" as const, text: content }] };
  });

  server.registerTool("brain_find_expert", {
    description:
      "Find domain experts across all connected repos. Returns domains with active agent sessions.",
  }, async () => {
    return jsonResult(brain.findExperts());
  });

  server.registerTool("brain_claim_domain", {
    description:
      "Claim this repo's domain identity for your agent session. Requires prior messaging_register.",
    inputSchema: {
      agent_id: z
        .string()
        .trim()
        .min(1)
        .describe("Your registered agent name"),
    },
  }, async ({ agent_id }) => {
    return withAgent(onAgentId, agent_id, () => {
      brain.claimDomain(agent_id);
      return jsonResult({
        claimed: config?.domain?.identifier ?? null,
        agent_id,
      });
    });
  });
}

// --- Main adapter ---

export interface McpStdioOpts {
  messaging: MessagingService;
  brain: BrainService;
  config: OctoSantaConfig | null;
  brainIndex?: BrainDoc[];
  registerNotificationHandler: (
    agentId: string,
    port: NotificationPort
  ) => void;
  unregisterNotificationHandler: (agentId: string) => void;
  agents: AgentRepository;
  /** Factory invoked once per session when an agent binds. Returns a handle with stop(). */
  startPoller: (port: NotificationPort, agentId: string) => { stop(): void };
  heartbeatIntervalMs?: number;
  onDisconnect: (agentId: string, pid: number) => void;
}

export async function startMcpStdio(opts: McpStdioOpts): Promise<void> {
  const {
    messaging,
    brain,
    config,
    brainIndex,
    registerNotificationHandler,
    unregisterNotificationHandler,
    agents,
    startPoller,
    heartbeatIntervalMs = 10_000,
    onDisconnect,
  } = opts;

  const hasBrain = !!(config?.brain?.dirs || config?.brain?.files);

  const mcpServer = new McpServer(
    { name: "octo-santa", version: "0.7.0" },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
      },
      instructions: buildInstructions(config, brainIndex),
    }
  );

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let boundAgentId: string | null = null;
  let pollerRef: { stop(): void } | null = null;

  function onAgentId(agentId: string): { commit: () => void } {
    if (boundAgentId !== null) {
      if (boundAgentId !== agentId) {
        throw new Error(
          `Session already bound to agent "${boundAgentId}", cannot use "${agentId}"`
        );
      }
      return { commit: () => {} };
    }
    // Deferred binding — caller must commit() after successful operation
    return {
      commit: () => {
        if (boundAgentId !== null) return; // Already bound (concurrent commit)
        boundAgentId = agentId;
        const port: NotificationPort = {
          notify: (content, meta) =>
            mcpServer.server.notification({
              method: "notifications/claude/channel",
              params: { content, meta },
            }),
        };
        registerNotificationHandler(agentId, port);
        pollerRef = startPoller(port, agentId);
        heartbeatTimer = setInterval(() => {
          const result = agents.heartbeatOrReclaim(agentId, process.pid);
          if (result === "lost") {
            clearInterval(heartbeatTimer!);
            heartbeatTimer = null;
          }
        }, heartbeatIntervalMs);
        heartbeatTimer.unref();
      },
    };
  }

  registerMessagingTools(mcpServer, messaging, onAgentId);
  registerBrainTools(mcpServer, brain, config, hasBrain, onAgentId);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  mcpServer.server.onclose = async () => {
    try {
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      pollerRef?.stop();
      if (boundAgentId) unregisterNotificationHandler(boundAgentId);
    } finally {
      if (boundAgentId) {
        onDisconnect(boundAgentId, process.pid);
      }
    }
  };

  // Bootstrap nudge — prompt agent to register before any tool call
  let bootstrapMsg =
    "octo-santa messaging module is available. Call messaging_register with a unique agent name (e.g. your role), then create or subscribe to channels to start receiving push notifications. If the name is taken, pick a different one.";
  if (config?.domain) {
    bootstrapMsg +=
      `\n\nBrain module active — this repo is domain "${config.domain.identifier}" (${config.domain.description}). ` +
      "After messaging_register, call brain_claim_domain to become a queryable expert.";
  }
  if (brainIndex && brainIndex.length > 0) {
    const index = brainIndex
      .map((d) => `- [${d.path}](${d.slug}) — ${d.summary}`)
      .join("\n");
    bootstrapMsg += `\n\nBrain index:\n${index}`;
  }
  await mcpServer.server.notification({
    method: "notifications/claude/channel",
    params: { content: bootstrapMsg, meta: { type: "bootstrap" } },
  });

  log("octo-santa MCP server running");
}
