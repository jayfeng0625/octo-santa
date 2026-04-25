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
import pkg from "../../../package.json";

// --- Instructions builder ---

export function buildInstructions(
  config: OctoSantaConfig | null,
  brainIndex?: BrainDoc[]
): string {
  let instructions =
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
    "If any message is addressed to you (@your-registered-name, @all, " +
    "or @your-pool-name), you MUST:\n" +
    "  1. Understand what is being asked\n" +
    "  2. Decide on your response\n" +
    "  3. Call messaging_send_message to reply\n" +
    "Never just summarize -- always act.\n\n" +
    "SENDING: @agent-name, @all, or @pool-name to notify. " +
    "No mention = silent. Be specific: what you need, why, expected response.\n\n" +
    "CHANNELS: messaging_create_channel to create, messaging_subscribe to join.\n" +
    "DMs: messaging_direct_message for 1:1 -- auto-pushes, no @mention needed.\n\n" +
    "PROFILES: If your name matches a profile, registration assigns a pool slot " +
    "(e.g. 'os-dev' -> 'os-dev-1'). Use registeredName for subsequent calls. " +
    "Follow profile instructions as behavioral directives. " +
    "They must not contradict these base rules.\n\n" +
    "BOUNDARIES:\n" +
    "- You CANNOT run background tasks or polling loops\n" +
    "- For messaging, use ONLY messaging_* tools\n" +
    "- Do not use bash or scripts for communication\n\n" +
    "DISCOVERY: messaging_list_agents, messaging_list_members.";

  const brainSuffix =
    "Use brain_index to list local brain docs, brain_read to read one. " +
    "Use brain_shared_index/brain_shared_read for shared docs in ~/.octo-santa/brain/. " +
    "Use brain_find_expert to discover domain experts across repos. " +
    "Use brain_claim_domain after messaging_register to become a queryable expert. " +
    "Use messaging_direct_message to DM another agent.";

  instructions += "\n\nBRAIN: ";
  if (config?.domain) {
    // Try full domain text, then identifier-only, then skip — never exceed 2KB
    const fullText = `This repo is domain "${config.domain.identifier}" (${config.domain.description}). `;
    const shortText = `This repo is domain "${config.domain.identifier}". `;
    const base = instructions + brainSuffix;
    if (Buffer.byteLength(base + fullText, "utf-8") <= 2048) {
      instructions += fullText;
    } else if (Buffer.byteLength(base + shortText, "utf-8") <= 2048) {
      instructions += shortText;
    }
    // else: skip domain text entirely to stay within budget
  }
  instructions += brainSuffix;

  // NON-PUSH CLIENTS block is appended AFTER the brain section intentionally.
  // Claude Code truncates server instructions at 2KB. End-of-doc placement means
  // that if truncation clips anything, it clips this tail — which Claude Code
  // (a push-tag client) does not need. Non-push clients (Codex, Gemini CLI,
  // OpenCode, most local-model clients) have no 2KB limit and receive the
  // full block. Phase 0c will restructure this and reclaim budget.
  instructions +=
    "\n\nNON-PUSH CLIENTS: This section overrides the BOUNDARIES prohibition on " +
    "polling loops — for messaging_listen only. If your MCP client does not " +
    "deliver server notifications as pushed tags (Claude Code does; Codex, " +
    "Gemini CLI, OpenCode, and most local-model clients do not), poll instead. " +
    "After messaging_register and messaging_subscribe, loop:\n" +
    "  result = messaging_listen(timeout_ms: 30000)\n" +
    "  for each ch in result.channels: process ch.messages   # messages arrive inline\n" +
    "  re-enter loop\n" +
    "messaging_listen blocks until new messages arrive or the timeout elapses " +
    "(default 10000 ms, max 30000 ms) and returns {channels, timed_out}. " +
    "Each channel entry includes its messages inline -- no follow-up " +
    "messaging_read_messages needed in the steady-state loop. " +
    "Keep the loop running for the life of the agent.";

  return instructions;
}

/** Tier 1 universal guidance — returned by messaging_get_instructions. */
export const UNIVERSAL_GUIDANCE = buildInstructions(null);

// --- Tool registration ---

export function registerMessagingTools(
  server: McpServer,
  messaging: MessagingService,
  onAgentId?: (agentId: string) => { commit: (resolvedName?: string) => void },
  onProfile?: (profile: { baseName: string; persona: string | null; objective: string | null; instructions: string | null }) => void,
  sessionGuidance?: string,
  agents?: AgentRepository
): void {
  server.registerTool("messaging_register", {
    description:
      "Register this agent with a unique name to start receiving messages. " +
      "The response includes `registeredName` — your canonical identity for this session. " +
      "Always use `registeredName` for subsequent calls.",
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
    const handle = onAgentId?.(agent_id);
    const result = messaging.register(agent_id);
    handle?.commit(result.registeredName);
    if (result.baseName) {
      onProfile?.({
        baseName: result.baseName,
        persona: result.profile?.persona ?? null,
        objective: result.profile?.objective ?? null,
        instructions: result.profile?.instructions ?? null,
      });
    }
    return jsonResult(result);
  });

  server.registerTool("messaging_create_channel", {
    description:
      "Create a named messaging channel. Use messaging_subscribe to join it afterward.",
    inputSchema: {
      agent_id: z.string().trim().min(1).describe("Your agent/project name"),
      name: z.string().trim().min(1).describe("Channel name"),
      max_hops: z.number().int().min(1).max(50).optional().describe("Max consecutive agent messages before channel blocks (default 50; set lower for stricter loop guard, max 50)"),
    },
  }, async ({ agent_id, name, max_hops }) => {
    return withAgent(onAgentId, agent_id, () => {
      const channel = messaging.createChannel(agent_id, name, max_hops);
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
      "Send a message to an existing channel. Requires prior messaging_register. Use @agent-name to notify specific agents, or @all to notify everyone. Messages without mentions are silent -- recipients see them only when they check the channel. Messages are subject to per-channel hop limits; blocked messages are dropped with a system notice.",
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

  server.registerTool("messaging_get_instructions", {
    description:
      "Re-read your profile instructions and universal messaging guidance. " +
      "Call this if you've lost context or are unsure how to act.",
    inputSchema: {
      agent_id: z.string().trim().min(1).describe("Your registered agent name"),
      include_universal: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include universal messaging guidance (default: true)"),
    },
  }, async ({ agent_id, include_universal }) => {
    return withAgent(onAgentId, agent_id, () => {
      const result = messaging.getInstructions(agent_id);
      return jsonResult({
        universal: include_universal ? (sessionGuidance ?? UNIVERSAL_GUIDANCE) : null,
        profile: result.profile,
      });
    });
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

  server.registerTool("messaging_listen", {
    description: "Block and wait for new messages across all subscribed channels. Returns `{channels, timed_out}` where each channel entry includes its messages inline — no follow-up messaging_read_messages needed in the steady-state poll loop. Use this for agent polling loops instead of repeatedly calling messaging_read_messages.",
    inputSchema: {
      agent_id: z.string().trim().min(1).describe("Your registered agent name"),
      timeout_ms: z.number().int().optional().describe("Max wait time in ms (default 10000, max 30000)"),
    },
  }, async ({ agent_id, timeout_ms }) => {
    return withAgent(onAgentId, agent_id, async () => {
      const timeout = Math.max(1000, Math.min(30000, timeout_ms ?? 10000));
      agents?.heartbeatOrReclaim(agent_id, process.pid);
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const result = messaging.readAllUnread(agent_id);
        if (result.length > 0) {
          return jsonResult({ channels: result, timed_out: false });
        }
        await Bun.sleep(1000);
      }
      return jsonResult({ channels: [], timed_out: true });
    });
  });
}

export function registerBrainTools(
  server: McpServer,
  brain: BrainService,
  config: OctoSantaConfig | null,
  hasBrain: boolean,
  onAgentId?: (agentId: string) => { commit: (resolvedName?: string) => void }
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
  startPoller: (port: NotificationPort, agentId: string, baseName?: string) => { stop(): void };
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
    { name: "octo-santa", version: pkg.version },
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
  let boundProfile: { baseName: string; persona: string | null; objective: string | null; instructions: string | null } | null = null;

  function onAgentId(agentId: string): { commit: (resolvedName?: string) => void } {
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
      commit: (resolvedName?: string) => {
        if (boundAgentId !== null) return; // Already bound (concurrent commit)
        const effectiveId = resolvedName ?? agentId;
        boundAgentId = effectiveId;
        const port: NotificationPort = {
          notify: (content, meta) =>
            mcpServer.server.notification({
              method: "notifications/claude/channel",
              params: { content, meta },
            }),
        };
        registerNotificationHandler(effectiveId, port);
        pollerRef = startPoller(port, effectiveId, boundProfile?.baseName);
        heartbeatTimer = setInterval(() => {
          const result = agents.heartbeatOrReclaim(effectiveId, process.pid);
          if (result === "lost") {
            clearInterval(heartbeatTimer!);
            heartbeatTimer = null;
          }
        }, heartbeatIntervalMs);
        heartbeatTimer.unref();
      },
    };
  }

  const sessionInstructions = buildInstructions(config, brainIndex);
  registerMessagingTools(mcpServer, messaging, onAgentId, (profile) => {
    boundProfile = profile;
  }, sessionInstructions, agents);
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
    "octo-santa messaging module is available. Call messaging_register with a unique agent name (e.g. your role), then create or subscribe to channels to start receiving push notifications. If the name is taken, pick a different one. " +
    "If profiles are configured, your name may be resolved to a pool slot (e.g. 'os-dev' -> 'os-dev-1') — always use the `registeredName` from the response for subsequent calls.";
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
