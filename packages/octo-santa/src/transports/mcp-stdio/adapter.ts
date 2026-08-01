import {
  McpServer,
  ResourceTemplate,
  ResourceNotFoundError,
} from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import type { MessagingService } from "../../core/messaging/service";
import { ChannelNotFoundError } from "../../core/messaging/errors";
import type { NotificationPort, AgentRepository } from "../../core/ports";
import {
  CHANNEL_NAME_RE,
  CHANNEL_NAME_RULE,
  MAX_CHANNEL_NAME_LENGTH,
  MAX_MESSAGE_LENGTH,
} from "../../core/utils";
import { log } from "../../log";
import { jsonResult, withAgent, LOCAL } from "./helpers";
import {
  RegisterOutput,
  CreateChannelOutput,
  SubscribeOutput,
  ListChannelsOutput,
  SendOutput,
  ReadMessagesOutput,
  ListAgentsOutput,
  ListMembersOutput,
  RenameChannelOutput,
} from "./schemas";
import pkg from "../../../package.json";

// Claude Code truncates server instructions at 2KB — keep this text under
// that limit.
export function buildInstructions(): string {
  return (
    "octo-santa messaging module is available. Call messaging_register with a " +
    "unique agent name (e.g. your role). If the name is taken, pick a different one.\n\n" +
    "You must call messaging_register before sending, reading, creating channels, " +
    "or subscribing. Read-only tools (messaging_list_channels, messaging_list_agents, " +
    "messaging_list_members) work without registration.\n\n" +
    "REACTING TO MESSAGES:\n" +
    "Messages are PUSHED to you as <channel source=\"octo-santa\" ...> tags " +
    "when you are mentioned or receive a DM. Do NOT poll messaging_read_messages in a loop -- " +
    "wait for tags to arrive, then call messaging_read_messages for that channel.\n" +
    "Unread delivery is read-once; use before_id for history.\n" +
    "If any message is addressed to you (@your-agent-name or @all), you MUST:\n" +
    "  1. Understand what is being asked\n" +
    "  2. Decide on your response\n" +
    "  3. Call messaging_send to reply\n" +
    "Never just summarize -- always act.\n\n" +
    "SENDING: messaging_send with channel:<name> to post; @agent-name or @all " +
    "to notify. No mention = silent. Be specific: what you need, why, " +
    "expected response.\n\n" +
    "CHANNELS: messaging_create_channel to create (auto-joins you), " +
    "messaging_subscribe to join an existing channel.\n" +
    "DMs: messaging_send with to:<agent> for 1:1 -- auto-pushes, no @mention needed.\n\n" +
    "RESOURCES (MCP): each channel is a resource at " +
    "octo-santa://channels/<url-encoded-name>/messages. resources/read returns " +
    "recent history (newest 50, including your own messages) and NEVER consumes unread -- " +
    "cursors belong to messaging_read_messages only. Modern clients can subscribe via " +
    "subscriptions/listen for notifications/resources/updated pings on ALL new messages " +
    "in a channel (not just mentions; your own sends excluded).\n\n" +
    "BOUNDARIES:\n" +
    "- You CANNOT run background tasks or polling loops\n" +
    "- For messaging, use ONLY messaging_* tools\n" +
    "- Do not use bash or scripts for communication\n\n" +
    "DISCOVERY: messaging_list_agents, messaging_list_members."
  );
}

export function registerMessagingTools(
  server: McpServer,
  messaging: MessagingService,
  onAgentId?: (agentId: string) => { commit: () => void }
): void {
  server.registerTool("messaging_register", {
    title: "Register agent",
    description:
      "Register this agent under a unique name to start receiving messages.",
    annotations: { ...LOCAL, readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    outputSchema: RegisterOutput,
    inputSchema: z.object({
      agent_id: z
        .string()
        .trim()
        .min(1)
        .regex(
          /^[\w-]+$/,
          "Must be letters, digits, underscores, or hyphens"
        )
        .describe("Your agent/project name"),
    }),
  }, async ({ agent_id }) => {
    const handle = onAgentId?.(agent_id);
    const result = messaging.register(agent_id);
    handle?.commit();
    return jsonResult(result);
  });

  server.registerTool("messaging_create_channel", {
    title: "Create channel",
    description:
      "Create a named channel and auto-join it as a member.",
    annotations: { ...LOCAL, readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    outputSchema: CreateChannelOutput,
    inputSchema: z.object({
      agent_id: z.string().trim().min(1).describe("Your agent/project name"),
      name: z.string().trim().min(1).max(MAX_CHANNEL_NAME_LENGTH, `Channel name must not exceed ${MAX_CHANNEL_NAME_LENGTH} characters`).regex(CHANNEL_NAME_RE, CHANNEL_NAME_RULE).describe("Channel name"),
    }),
  }, async ({ agent_id, name }) => {
    return withAgent(onAgentId, agent_id, () => {
      const channel = messaging.createChannel(agent_id, name);
      return jsonResult(channel);
    });
  });

  server.registerTool("messaging_subscribe", {
    title: "Subscribe to channel",
    description:
      "Subscribe to an existing channel to start receiving notifications.",
    annotations: { ...LOCAL, readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    outputSchema: SubscribeOutput,
    inputSchema: z.object({
      agent_id: z.string().trim().min(1).describe("Your agent/project name"),
      channel: z
        .string()
        .trim()
        .min(1)
        .describe("Channel name to subscribe to"),
    }),
  }, async ({ agent_id, channel }) => {
    return withAgent(onAgentId, agent_id, () => {
      messaging.subscribe(agent_id, channel);
      return jsonResult({ subscribed: true, channel });
    });
  });

  server.registerTool("messaging_list_channels", {
    title: "List channels",
    description: "List all messaging channels",
    annotations: { ...LOCAL, readOnlyHint: true, idempotentHint: true },
    outputSchema: ListChannelsOutput,
  }, async () => {
    return jsonResult({ channels: messaging.listChannels() });
  });

  server.registerTool("messaging_send", {
    title: "Send message or DM",
    description:
      "Send a message: set `channel` to post to a channel, or `to` to DM an agent (auto-creates the DM and pushes to both -- no @mention needed). Provide exactly one. In channels, @agent-name or @all notifies; no mention is silent.",
    annotations: { ...LOCAL, readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    outputSchema: SendOutput,
    inputSchema: z.object({
      agent_id: z.string().trim().min(1).describe("Your agent/project name"),
      channel: z.string().trim().min(1).optional().describe("Channel to post to (mutually exclusive with `to`)"),
      to: z.string().trim().min(1).optional().describe("Agent to direct-message (mutually exclusive with `channel`)"),
      content: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH, `Message content must not exceed ${MAX_MESSAGE_LENGTH.toLocaleString("en-US")} characters`).describe("Message content"),
    }),
  }, async ({ agent_id, channel, to, content }) => {
    return withAgent(onAgentId, agent_id, () => {
      if ((channel == null) === (to == null)) {
        throw new Error("Provide exactly one of `channel` or `to`");
      }
      return jsonResult(
        to != null
          ? messaging.directMessage(agent_id, to, content)
          : messaging.send(agent_id, channel!, content)
      );
    });
  });

  server.registerTool("messaging_read_messages", {
    title: "Read messages",
    description:
      "Read unread messages from a channel, or fetch older history with before_id. Requires channel membership.",
    // Not readOnly: the default mode consumes the unread cursor (read-once).
    annotations: { ...LOCAL, readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    outputSchema: ReadMessagesOutput,
    inputSchema: z.object({
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
    }),
  }, async ({ agent_id, channel, limit, before_id }) => {
    return withAgent(onAgentId, agent_id, () =>
      jsonResult({ messages: messaging.read(agent_id, channel, { limit, before_id }) })
    );
  });

  server.registerTool("messaging_list_agents", {
    title: "List agents",
    description:
      "List agents — active only by default; set include_stale to include disconnected ones.",
    annotations: { ...LOCAL, readOnlyHint: true, idempotentHint: true },
    outputSchema: ListAgentsOutput,
    inputSchema: z.object({
      include_stale: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, include stale/disconnected agents (default: active only)"
        ),
    }),
  }, async ({ include_stale }) => {
    return jsonResult({ agents: messaging.listAgents(include_stale) });
  });

  server.registerTool("messaging_list_members", {
    title: "List channel members",
    description:
      "List a channel's members with their active/inactive status.",
    annotations: { ...LOCAL, readOnlyHint: true, idempotentHint: true },
    outputSchema: ListMembersOutput,
    inputSchema: z.object({
      channel: z.string().trim().min(1).describe("Channel name"),
    }),
  }, async ({ channel }) => {
    return jsonResult({ members: messaging.listMembers(channel) });
  });

  server.registerTool("messaging_rename_channel", {
    title: "Rename channel",
    description: "Rename a channel. You must be a member.",
    annotations: { ...LOCAL, readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    outputSchema: RenameChannelOutput,
    inputSchema: z.object({
      agent_id: z.string().trim().min(1).describe("Your agent/project name"),
      channel: z.string().trim().min(1).describe("Current channel name"),
      new_name: z.string().trim().min(1).describe("New channel name"),
    }),
  }, async ({ agent_id, channel, new_name }) => {
    return withAgent(onAgentId, agent_id, () =>
      jsonResult(messaging.renameChannel(agent_id, channel, new_name))
    );
  });

}

// Every mint of a channel resource URI must go through this helper: the
// listen router's per-URI subscription filter is an exact string comparison,
// so list, read, and updated-ping URIs have to be byte-identical. Channel
// names allow [\w.,@#-]; percent-encoding keeps `#` out of the fragment and
// `,` (every DM channel name) matchable by the template's {channel} variable,
// which rejects raw commas.
export function channelResourceUri(name: string): string {
  return `octo-santa://channels/${encodeURIComponent(name)}/messages`;
}

export function registerChannelResources(
  server: McpServer,
  messaging: MessagingService,
  getBoundAgentId: () => string | null
): void {
  server.registerResource(
    "channel-messages",
    new ResourceTemplate("octo-santa://channels/{channel}/messages", {
      list: () => ({
        resources: messaging.listChannels().map((channel) => ({
          uri: channelResourceUri(channel.name),
          name: channel.name,
          description: `Message history of channel "${channel.name}"`,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Channel messages",
      description:
        "Recent message history of a channel. Pure read — never advances the unread cursor.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      // UriTemplate.match does not decode, so the raw variable arrives
      // percent-encoded exactly as minted by channelResourceUri.
      const raw = variables["channel"];
      const encoded = Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
      let channelName: string;
      try {
        channelName = decodeURIComponent(encoded);
      } catch {
        throw new ResourceNotFoundError(uri.toString());
      }
      const agentId = getBoundAgentId();
      if (agentId === null) {
        throw new Error(
          "Channel resources require a bound agent: call messaging_register first"
        );
      }
      try {
        const messages = messaging.readHistory(agentId, channelName, 50);
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: "application/json",
              text: JSON.stringify(messages),
            },
          ],
        };
      } catch (error) {
        if (error instanceof ChannelNotFoundError) {
          throw new ResourceNotFoundError(uri.toString());
        }
        throw error;
      }
    }
  );
}

// Builds the per-connection NotificationPort the poller drives. The custom
// content push is era-blind (the stdio entry passes non-spec notification
// methods straight through on both eras). The spec-native channel-activity
// signal is modern-only: on a legacy connection the entry installs no listen
// router, so resources/updated would reach a client that never asked,
// unsolicited and unstamped — the era gate keeps legacy spec-compliant.
export function createConnectionNotificationPort(
  mcpServer: McpServer,
  era: "legacy" | "modern"
): NotificationPort {
  const seenChannels = new Set<string>();
  return {
    notify: (content, meta) =>
      mcpServer.server.notification({
        method: "notifications/claude/channel",
        params: { content, meta },
      }),
    notifyChannelActivity: async (channelName) => {
      if (era !== "modern") return;
      // First-seen heuristic: activity on a channel this connection has not
      // seen before implies the resource list may have changed (channel
      // creation and rename both surface as messages under the new name).
      if (!seenChannels.has(channelName)) {
        seenChannels.add(channelName);
        mcpServer.sendResourceListChanged();
      }
      await mcpServer.server.sendResourceUpdated({
        uri: channelResourceUri(channelName),
      });
    },
  };
}

export interface McpStdioOpts {
  messaging: MessagingService;
  agents: AgentRepository;
  startPoller: (port: NotificationPort, agentId: string) => { stop(): void };
  heartbeatIntervalMs?: number;
  onDisconnect: (agentId: string) => void;
}

const BOOTSTRAP_MSG =
  "octo-santa messaging module is available. Call messaging_register with a unique agent name (e.g. your role), then create or subscribe to channels to start receiving push notifications. If the name is taken, pick a different one.";

// Builds one server instance for one stdio connection. serveStdio calls this
// factory when the connection's opening message arrives and pins the instance
// for the connection lifetime (a `server/discover` probe instance may also be
// built and discarded — it never sees a tool call, so nothing binds on it).
// All per-connection state (agent binding, poller, heartbeat) lives in this
// closure; everything durable lives in SQLite.
function buildConnectionServer(
  opts: McpStdioOpts,
  era: "legacy" | "modern"
): McpServer {
  const {
    messaging,
    agents,
    startPoller,
    heartbeatIntervalMs = 10_000,
    onDisconnect,
  } = opts;

  const mcpServer = new McpServer(
    { name: "octo-santa", version: pkg.version },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
        // `subscribe` must be declared here in the constructor: the stdio
        // entry hands getCapabilities() to the listen router right after this
        // factory returns, and nothing auto-sets the subscribe bit — without
        // it the router strips resourceSubscriptions from every listen ack.
        // Legacy connections cannot serve subscriptions (SDK v2 registers no
        // resources/subscribe handler), so they must not advertise it.
        resources:
          era === "modern"
            ? { subscribe: true, listChanged: true }
            : { listChanged: true },
      },
      instructions: buildInstructions(),
    }
  );

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let boundAgentId: string | null = null;
  let pollerRef: { stop(): void } | null = null;

  // Binds the connection to the first agent id that completes a tool call.
  // Binding is deferred until commit() so a failed register doesn't bind.
  function onAgentId(agentId: string): { commit: () => void } {
    if (boundAgentId !== null) {
      if (boundAgentId !== agentId) {
        throw new Error(
          `Session already bound to agent "${boundAgentId}", cannot use "${agentId}"`
        );
      }
      return { commit: () => {} };
    }
    return {
      commit: () => {
        if (boundAgentId !== null) return;
        boundAgentId = agentId;
        const port = createConnectionNotificationPort(mcpServer, era);
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
  registerChannelResources(mcpServer, messaging, () => boundAgentId);

  mcpServer.server.onclose = () => {
    try {
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      pollerRef?.stop();
    } finally {
      if (boundAgentId) {
        onDisconnect(boundAgentId);
      }
    }
  };

  if (era === "legacy") {
    // 2025-era connections complete an initialize handshake; nudge the agent
    // once it finishes. 2026-07-28 connections are stateless — no handshake,
    // and clients must opt in to notification streams — so the same guidance
    // reaches them as server instructions via `server/discover` instead.
    mcpServer.server.oninitialized = () => {
      void mcpServer.server
        .notification({
          method: "notifications/claude/channel",
          params: { content: BOOTSTRAP_MSG, meta: { type: "bootstrap" } },
        })
        .catch((error) => log(`bootstrap notification failed: ${error}`));
    };
  }

  return mcpServer;
}

export function startMcpStdio(opts: McpStdioOpts): StdioServerHandle {
  // serveStdio owns the transport and the protocol-era decision: the same
  // factory serves stateless 2026-07-28 connections and 2025-era handshake
  // connections, pinning one fresh instance per connection.
  const handle = serveStdio((ctx) => buildConnectionServer(opts, ctx.era), {
    onerror: (error) => log(`mcp stdio error: ${error}`),
  });

  log("octo-santa MCP server running");
  return handle;
}
