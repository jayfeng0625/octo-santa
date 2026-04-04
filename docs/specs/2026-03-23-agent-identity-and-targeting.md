---
title: Agent Identity and Targeted Notifications
summary: Spec for persistent agent identity, @mention targeting, and DM channels for direct agent-to-agent messaging
tags: [agents, identity, messaging, mentions, dm, direct-message, channels, subscribe]
---

# Agent Identity and Targeted Notifications

> Status: Spec

## Problem

Two issues with the current messaging module:

### 1. Push notifications require a tool call to activate

The polling loop only starts when `onAgentId` fires on the first tool call that includes an `agent_id`. If an agent session starts with channels enabled but hasn't called any messaging tool yet, it has no way to know there are messages waiting.

### 2. No way to target specific agents

All messages on a channel are broadcast to every subscriber. In a project with 10 agents, a message meant for one agent wastes tokens for the other 9 who have to parse a notification that isn't for them.

## Design

### Agent Identity

**Self-naming.** Agents choose their own name at runtime via `messaging_register(agent_id)`. Names are human-readable and role-based (e.g., `"code-reviewer"`, `"frontend-lead"`). The naming convention is `project-name` for the first agent in a project, then `project-name-role` for subsequent agents.

**Stability across restarts.** Re-registering with the same name reclaims the existing agent row — `last_seen_at` updates, cursors and message history are preserved. This is already how `registerAgent` works (upsert).

**Name constraints.** Agent names must match `[\w-]+` (letters, digits, underscores, hyphens). This is enforced on all tool calls — both explicit registration and implicit agent creation via `messaging_send_message`, `messaging_read_messages`, etc. The reserved names `all` and `here` are rejected to prevent conflicts with broadcast mention tokens.

**Duplicate prevention via PID liveness check.** A new `pid` column and `registered_at` timestamp on the `agents` table store the registering process's identity. On registration, the entire check-and-reclaim sequence runs inside an exclusive SQLite transaction to prevent races between concurrent processes:

1. Check if an agent with that name already exists
2. If it does, call `process.kill(existingPid, 0)` to check liveness. `ESRCH` means dead; `EPERM` means alive but not signalable (treated as alive).
3. Dead process (or stale `last_seen_at` with PID reuse) → reclaim the name (update PID, `registered_at`, and `last_seen_at`)
4. Live process with recent `last_seen_at` → reject with: `Agent "X" is already active (pid N). Choose a different name.`

The `last_seen_at` timestamp (refreshed by both tool calls and the polling heartbeat) mitigates PID reuse false positives: if the PID is alive but `last_seen_at` is old enough that the OS has likely recycled the PID, reclaim is allowed. The polling loop updates `last_seen_at` on each tick, so a passively-listening agent remains "fresh" and cannot be reclaimed.

On rejection, the error message is actionable — Claude will ask the user for an alternative name or pick a variant.

**Schema change:**

```sql
ALTER TABLE agents ADD COLUMN pid INTEGER;
ALTER TABLE agents ADD COLUMN registered_at INTEGER;
```

Existing agents get `pid = NULL` and `registered_at = NULL`, treated as "no liveness data, allow reclaim."

### Bootstrap

**Startup nudge.** When the MCP server process starts (spawned by Claude Code), it immediately sends a channel notification before any tool call:

```typescript
await mcp.notification({
  method: "notifications/claude/channel",
  params: {
    content: "octo-santa messaging module is available. Call messaging_register with a unique agent name, then read or send on a channel to start receiving push notifications.",
    meta: { type: "bootstrap" },
  },
});
```

**Enhanced MCP instructions.** The `instructions` string in the Server constructor is updated to cover registration, mention semantics, and discovery upfront.

**Fallback.** The existing `onAgentId` callback on any tool call with `agent_id` remains unchanged. If an agent skips registration and goes straight to `messaging_send_message`, polling starts via the fallback path. The new three-tier mention filtering applies regardless of how polling was started — there is no legacy "push everything" mode. Note: implicit paths (send/read/create_channel) validate agent name format but do **not** enforce PID-based ownership — ownership is only checked during explicit registration. This means a second process can use the same agent name via implicit paths without triggering a conflict. This is intentional: the fallback path prioritizes availability over identity exclusivity.

**No config file needed.** Bootstrap doesn't depend on a project config. The nudge fires unconditionally on startup. Channel subscription happens when the agent reads or sends to a channel (current cursor-creation behavior).

### @Mentions and Targeted Push

**Channel notify mode (auto-detected).** The push behavior depends on channel membership size, determined by counting cursor-holding agents with a non-null `pid` (i.e. agents that called `registerAgent`, which sets PID):

- **2 members** → **DM mode**: all messages auto-notify both members (no @mention required). This makes 2-agent channels behave like direct messages.
- **3+ members** → **Group mode**: push is opt-in via @mentions (three-tier filtering below).

When a 3rd registered agent joins a channel, the channel automatically transitions from DM mode to group mode. No manual configuration.

**Human REPL users are excluded from this count.** The human messaging REPL (`src/repl/`) uses in-memory cursor tracking and does not call `registerAgent` — it goes through the lightweight `ensureAgent` path (no PID). Cursor rows created by `sendMessage` for human senders have `pid IS NULL` and are filtered out of the member count query. This means a human observer or participant never affects the DM/group notification mode for agents.

**Three notification tiers (group mode, 3+ members):**

| Message content | Push behavior |
|---|---|
| No @mentions | **Silent** — no push to anyone. Agents see it when they actively `readMessages`. |
| `@agent-name` | **Targeted** — push only to the mentioned agent(s). |
| `@all` | **Broadcast** — push to all channel subscribers. |

This inverts the current default. Today every new message triggers a push. With this change, push is opt-in via mentions in group channels.

**Parsing.** At send time, `sendMessage` extracts mentions via `/@([\w-]+)/g`. The regex intentionally trades precision for simplicity — it will match mentions inside code blocks or URLs, which is acceptable for this system. The special token `@all` is recognized but not stored as an agent name — it maps to a sentinel value. Mentioned agent names are validated against the `agents` table; invalid mentions are silently dropped. `@all` is always valid.

**Storage.** New column on `messages`:

```sql
ALTER TABLE messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]';
```

Stores a JSON array of agent IDs. Examples:
- `@code-reviewer @frontend-lead` → `["code-reviewer", "frontend-lead"]`
- `@all` or `@here` → `["*"]` (sentinel value)
- No mentions → `[]`

**Push filtering in `tick()`.** The polling loop determines notify behavior per channel:

```
DM mode (2 members):
  → push all messages (no mention check)

Group mode (3+ members):
  mentions = []        → skip (silent)
  mentions has "*"     → push to all subscribers
  mentions has agentId → push to this agent
  otherwise            → skip
```

Member count is determined by counting cursor rows for agents with `pid IS NOT NULL` (`SELECT COUNT(*) FROM cursors cr JOIN agents a ON cr.agent_id = a.id WHERE cr.channel_id = ? AND a.pid IS NOT NULL`). Only agents that called `registerAgent` (which sets PID) count. Cursor rows from `sendMessage`'s sender upsert for human REPL users (who go through `ensureAgent`, no PID) are excluded.

**Visibility unchanged.** `readMessages` returns all messages on the channel regardless of mentions. Mentions only control push notifications, not access.

**Discovery.** `messaging_list_agents` returns all known agents. Agents use it to discover who they can @mention. For channel-level visibility, `messaging_list_members` returns the members of a specific channel with an `active` flag derived from liveness. For online presence across all channels, `messaging_list_agents({ active_only: true })` filters to agents seen within the liveness window.

> **Note:** The agent lifecycle spec (`2026-03-24-agent-lifecycle-and-membership.md`) supersedes the PID staleness window and DM/group member counting logic described here. See that spec for the authoritative liveness tiers and `last_seen_at`-based freshness model.

### Agent Guidance

Agents learn the system through the MCP protocol itself — no external docs needed.

**MCP `instructions` (system prompt).** Updated to cover registration, mention semantics, and discovery. Scoped to the messaging module (not the whole system, since messaging is one of octo-santa's modules):

```
octo-santa messaging module is available. Call messaging_register with a
unique agent name (e.g. your role), then read or send on a channel to
start receiving push notifications. If the name is taken, pick a
different one.

Messages from other agents arrive as <channel source="octo-santa" ...>
tags. To acknowledge and see full history, call messaging_read_messages
with the channel_name. To reply, call messaging_send_message.

CHANNELS: Messages live in named channels. Use messaging_send_message to
send and messaging_read_messages to read. Channels are created on first use.

MENTIONS:
- @agent-name → only that agent gets notified
- @all → all channel subscribers get notified
- No mention → message is silent (recipients must read actively)

Use @mentions to get attention. Messages without mentions are for
context/logging — recipients see them when they check the channel.

DISCOVERY: Use messaging_list_agents to see known agents.
Use messaging_list_members to see who is in a specific channel.
```

**Tool descriptions.** `messaging_send_message`'s description updated to mention the @mention behavior:

```
Send a message to a channel. Use @agent-name to notify specific agents,
or @all to notify everyone. Messages without mentions are silent.
```

**Startup nudge.** The channel notification on startup prompts immediate registration.

**Error messages as guidance.** Actionable error strings that Claude can reason about:
- Duplicate name: `Agent "X" is already active (pid N). Choose a different name.`
- Invalid mention: silently dropped (don't interrupt the send)

## Migration

One new migration (`messaging_002_mentions_and_pid`):

```sql
ALTER TABLE agents ADD COLUMN pid INTEGER;
ALTER TABLE agents ADD COLUMN registered_at INTEGER;
ALTER TABLE messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]';
```

Backward-compatible: existing agents get `pid = NULL` and `registered_at = NULL` (treated as "no liveness data, allow reclaim"). Existing messages get `mentions = '[]'` (silent in group mode, auto-notify in DM mode). The `DEFAULT '[]'` clause is load-bearing — it ensures existing INSERT statements that don't supply `mentions` continue to work during the rollout window where the new schema exists but code hasn't been updated yet.

## Changes by File

- **`src/modules/messaging/tools.ts`** — Update `registerAgent` with PID storage, name validation (`[\w-]+`), and EPERM-aware liveness check inside an exclusive transaction. Staleness uses `last_seen_at` (not `registered_at`). Update `sendMessage` to parse mentions, store them, and upsert a cursor for the sender (membership tracking). Add mention extraction helper.
- **`src/modules/messaging/types.ts`** — Add `pid` and `registered_at` fields to `Agent` interface. Add `mentions` field to `Message` interface.
- **`src/channel.ts`** — Update `tick()` to count channel members and apply DM mode (2 members, auto-notify) vs. group mode (3+, mention-based filtering). Check ALL messages in batch for mentions (not just latest). Add `last_seen_at` heartbeat update per tick. Bound batch mentions query by `max_id`.
- **`src/modules/messaging/index.ts`** — Update MCP `instructions` and tool descriptions. Add agent name validation regex to `messaging_register` input schema. Name validation is also enforced at the DB layer via `ensureAgent`/`registerAgent` for all tools.
- **`src/server.ts`** — Wire startup nudge (send channel notification after `mcp.connect()`). Merge new instructions with existing `<channel>` tag guidance.
