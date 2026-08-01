import { z } from "zod";
import type { Agent, Channel, Message } from "../../core/messaging/types";

// Wire schemas for structured tool output (SDK v2 outputSchema). These mirror
// the core domain types; the `satisfies` clauses fail compilation if a core
// field is removed or renamed, and the tool-metadata contract tests validate
// real service output against them at runtime.

export const AgentSchema = z.object({
  id: z.string().describe("Agent name"),
  created_at: z.number().describe("Unix ms timestamp of first registration"),
  last_seen_at: z.number().describe("Unix ms timestamp of last heartbeat"),
  pid: z.number().nullable().describe("Owning process id, null when disconnected"),
  registered_at: z.number().nullable().describe("Unix ms timestamp of current registration, null when disconnected"),
}) satisfies z.ZodType<Agent>;

export const ChannelSchema = z.object({
  id: z.number().describe("Channel id"),
  name: z.string().describe("Channel name"),
  created_by: z.string().describe("Agent that created the channel"),
  created_at: z.number().describe("Unix ms timestamp of creation"),
}) satisfies z.ZodType<Channel>;

export const MessageSchema = z.object({
  id: z.number().describe("Message id (monotonic; usable as before_id)"),
  channel_id: z.number().describe("Channel id"),
  agent_id: z.string().describe("Sender agent name"),
  content: z.string().describe("Message content"),
  created_at: z.number().describe("Unix ms timestamp"),
  mentions: z.string().describe('JSON array of mentioned agent names, e.g. \'["agent-a"]\' or \'["*"]\''),
}) satisfies z.ZodType<Message>;

export const MemberSchema = z.object({
  agent_id: z.string().describe("Agent name"),
  active: z.boolean().describe("Whether the agent is currently active"),
});

// Per-tool output schemas. Every result is a top-level OBJECT: object-shaped
// structuredContent projects identically onto the 2025 and 2026-07-28 wire
// eras (non-object values get era-dependent wrapping), so lists are wrapped
// in named keys.

export const RegisterOutput = AgentSchema;
export const CreateChannelOutput = ChannelSchema;
export const SubscribeOutput = z.object({
  subscribed: z.literal(true),
  channel: z.string().describe("Channel name subscribed to"),
});
export const ListChannelsOutput = z.object({ channels: z.array(ChannelSchema) });
export const SendOutput = MessageSchema;
export const ReadMessagesOutput = z.object({ messages: z.array(MessageSchema) });
export const ListAgentsOutput = z.object({ agents: z.array(AgentSchema) });
export const ListMembersOutput = z.object({ members: z.array(MemberSchema) });
export const RenameChannelOutput = ChannelSchema;
