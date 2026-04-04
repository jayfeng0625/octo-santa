---
title: Octo-Santa Channel Push Notifications — Design Spec
summary: Design for automatic message push to agents using Claude Code Channels, replacing HTTP and stdio polling
tags: [messaging, channels, push-notifications, polling, subscribe, mcp]
---

# Octo-Santa Channel Push Notifications — Design Spec

## Overview

Add automatic message push to octo-santa using Claude Code's Channels feature. When another agent sends a message to a channel the receiving agent has read, the message appears in their conversation as a `<channel>` tag — no tool call, no polling loop, no server to start.

This replaces the HTTP transport + in-process pub/sub approach (feat/subscribe-push) and the stdio DB-polling subscribe approach (stdio-subscribe-design) with a simpler model: the server polls internally and pushes via the Channels protocol.

## Motivation

With the current stdio transport, agents must explicitly call `messaging_read_messages` to check for new messages (pull-based). This leads to either:
- Wasted tool calls on empty reads (frequent polling via `/loop`)
- Delayed message delivery (infrequent polling)
- Agents burning conversation context on polling loops

The Channels feature solves this: octo-santa polls the shared SQLite DB in the background (server-internal, not a tool call) and pushes unread messages directly into the agent's conversation context.

### Why not the previous approaches

| Approach | Problem |
|----------|---------|
| HTTP transport + in-process pub/sub (feat/subscribe-push) | Requires manually starting a server before connecting. Dealbreaker for plugin distribution — users expect install-and-go. |
| Stdio + `messaging_subscribe` DB-polling tool | Agent must call subscribe in a loop. Half-way house between channels push and `/loop` fallback — adds complexity without meaningful improvement over either. |
| Channels push (this spec) | Server polls internally, agent receives automatically. Zero setup (stdio, auto-spawned). Clean separation: server handles delivery, agent handles processing. |

## Architecture

### How it works

Each Claude Code session spawns its own octo-santa process via stdio (same as today). The process declares the `claude/channel` experimental capability. When the agent makes their first tool call with an `agent_id`, the server starts a background polling interval that checks the shared SQLite DB for unread messages. When unread messages are found, they're pushed to the agent via `notifications/claude/channel`.

```
Claude Code session A                    Claude Code session B
  └─ spawns octo-santa (stdio)            └─ spawns octo-santa (stdio)
       ├─ 7 messaging tools                    ├─ 7 messaging tools
       ├─ channel capability                   ├─ channel capability
       └─ background poll ──┐                  └─ background poll ──┐
                             │                                       │
                             ▼                                       ▼
                    ~/.octo-santa/messages.db (shared SQLite, WAL mode)
```

Agent B sends a message → writes to SQLite → Agent A's background poll finds it → pushes `<channel>` tag → Agent A sees it and acts.

### What stays the same

- Stdio MCP transport (each session = own process, auto-spawned by Claude Code)
- Shared SQLite database (`~/.octo-santa/messages.db`)
- The 7 core messaging tools (after removing `messaging_subscribe`): `messaging_register`, `messaging_create_channel`, `messaging_list_channels`, `messaging_send_message`, `messaging_read_messages`, `messaging_list_agents`, `messaging_list_members`
- `.mcp.json` uses `command`/`args` format (no server to start)
- Cursor model (read_messages advances cursor, acknowledges receipt)
- Module architecture (`OctoModule` interface)

### What changes

- `src/server.ts`: adds `experimental: { 'claude/channel': {} }` capability and `instructions` field
- New `src/channel.ts`: background polling loop + notification push logic
- `messaging_subscribe` tool: removed (replaced by channel push)
- `src/pubsub.ts`: removed (in-process pub/sub, dead in stdio)
- `src/sessions.ts`: removed (HTTP session manager, dead in stdio)
- `src/types.ts`: `registerTools` replaces `pubsub: PubSub` param with optional `onAgentId?: (agentId: string) => void` callback
- `sendMessage`: `onSend` callback removed (was for pub/sub notify)

## Server Configuration

### McpServer setup

octo-santa uses `McpServer` (high-level API) for tool registration via `server.tool()`. Channel notifications are sent via the underlying `Server` instance, accessed through `.server`.

**TypeScript type note:** The `notifications/claude/channel` method is a Claude Code extension, not part of the standard MCP `ServerNotification` union. Calling `mcpServer.server.notification()` with this method requires a type workaround. The official channel examples use the low-level `Server` class directly (with a custom notification type parameter), but since octo-santa already uses `McpServer` for tool registration convenience, we create a small typed helper to hide the cast rather than using raw `as any` or rewriting all tool registrations.

```typescript
// src/channel.ts — typed helper for channel notifications
function sendChannelNotification(
  server: McpServer,
  content: string,
  meta: Record<string, string>
): Promise<void> {
  return (server.server as any).notification({
    method: "notifications/claude/channel",
    params: { content, meta },
  });
}
```

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
      "If no channel tags appear, you can use /loop on messaging_read_messages as a fallback. " +
      "DISCOVERY: Use messaging_list_agents to see known agents. " +
      "Use messaging_list_members to see who is in a specific channel.",
  }
);
```

Reference: [Channels Reference — Server Options](https://code.claude.com/docs/en/channels-reference#server-options)

### .mcp.json (unchanged)

```json
{
  "mcpServers": {
    "octo-santa": {
      "command": "bun",
      "args": ["run", "/path/to/octo-santa/src/server.ts"]
    }
  }
}
```

## Channel Push Mechanism

### Agent identity binding

The server discovers which agent it's serving from the first tool call that carries `agent_id`. Tools that carry `agent_id` are: `messaging_register`, `messaging_create_channel`, `messaging_send_message`, `messaging_read_messages`. Tools that do NOT carry `agent_id` (`messaging_list_channels`, `messaging_list_agents`, `messaging_list_members`) cannot trigger binding.

**Mechanism:** `server.ts` passes an `onAgentId` callback to each module's `registerTools`. Tool handlers that receive `agent_id` call `onAgentId(agent_id)` **before** processing any DB mutation. This ensures mismatched agent IDs are rejected before any data is persisted. The callback is idempotent: first call binds the agent and starts polling; subsequent calls with the same ID are no-ops.

Once bound:
- The server stores the agent ID
- A background polling interval starts
- The agent ID is fixed for the lifetime of this session (one agent per stdio process)
- **Enforcement:** if a subsequent tool call passes a different `agent_id`, `onAgentId` throws an error. This prevents a single session from acting as multiple agents and ensures the polling loop watches the correct channels.

### Background polling loop (`src/channel.ts`)

```typescript
startPolling(db, agentId, notify, intervalMs = 3000) → stop(): Promise<void>
  1. Query subscribed channels: SELECT channel_id, channel_name FROM cursors JOIN channels WHERE agent_id = ?
  2. If no cursors, skip (agent hasn't read any channels yet)
  3. For each subscribed channel:
     a. Re-read cursor fresh: SELECT last_read_message_id FROM cursors WHERE agent_id = ? AND channel_id = ?
        (avoids stale snapshots when read_messages advances another channel's cursor mid-tick)
     b. If channel not yet in lastPushedId map, seed: lastPushedId[channel] = cursor.last_read_message_id
     c. Compute high-water mark: hwm = max(cursor.last_read_message_id, lastPushedId[channel])
     d. Count unread: SELECT COUNT(*), MAX(id) FROM messages WHERE channel_id = ? AND id > hwm AND agent_id != ?
     e. If count > 0, fetch latest: SELECT * FROM messages WHERE id = max_id
  4. Coalesce per channel: if multiple unread messages, send ONE notification with count and latest content.
     Only advance lastPushedId after notify resolves.
  5. Repeat on interval (serialized — next tick waits for current tick to complete)
  6. Returns stop() function that returns Promise<void> — resolves after any in-flight tick completes (quiescent shutdown)
```

**Polling interval:** 3 seconds (configurable via `OCTO_SANTA_POLL_INTERVAL_MS` env var). This gives 1-3 second notification latency — fast enough for coordination, light enough on SQLite reads.

**Duplicate prevention:** The poller tracks the highest pushed message ID per channel in memory (`lastPushedId`). The effective high-water mark for each channel is `max(cursor.last_read_message_id, lastPushedId[channel])` — this handles both acknowledged messages (cursor advanced) and pushed-but-unacknowledged messages (lastPushedId advanced). Only messages above this high-water mark are notified.

**Initialization:** `lastPushedId` is seeded per channel on first encounter — whenever a new cursor appears (either at startup or mid-session when the agent reads a new channel), `lastPushedId[channel]` is set to `cursor.last_read_message_id`. This prevents flooding historical messages on first poll. If the process restarts, `lastPushedId` resets and is re-initialized from the cursor. Messages pushed but not yet acknowledged may be re-pushed — acceptable since duplicate notifications are better than lost messages.

**Watermark advancement:** `lastPushedId` is only advanced *after* `notify()` resolves successfully. If `notify()` fails, the watermark stays put and the message is retried on the next tick.

**Coalescing:** If multiple unread messages exist on the same channel in a single tick, they are coalesced into one notification (e.g. "3 new messages on coordination" + latest message content). This prevents burst traffic from flooding the agent's conversation context. The agent calls `messaging_read_messages` for the full backlog.

**Self-exclusion:** Messages where `agent_id` matches the subscribing agent are skipped (agent doesn't get notified of their own messages).

### Notification format

```typescript
// Uses the typed helper from src/channel.ts
await sendChannelNotification(mcpServer, messageContent, {
  channel_name: "coordination",
  sender: "zynq",
  message_id: "42",
});
```

The agent sees:

```xml
<channel source="octo-santa" channel_name="coordination" sender="zynq" message_id="42">
deploy is ready, please review PR #123
</channel>
```

Reference: [Channels Reference — Notification Format](https://code.claude.com/docs/en/channels-reference#notification-format)

### Cursor behavior

Push does NOT advance cursors. The agent must call `messaging_read_messages` to acknowledge receipt and advance the cursor. This prevents lost messages if the agent is mid-task when the push arrives or if the session ends before the agent processes the message.

### Polling lifecycle

- **Starts:** after the first tool call with `agent_id`
- **Runs:** every `intervalMs` milliseconds (default 3000), serialized (next tick waits for current to complete)
- **Stops:** `startPolling()` returns an async `stop()` function (`() => Promise<void>`) that resolves after any in-flight tick completes (quiescent shutdown). The server awaits `stop()` when the transport closes. The timer is created with `unref()` so it doesn't keep the process alive if stdio closes unexpectedly.

```typescript
// In server.ts, wiring lifecycle:
const stop = startPolling(db, agentId, notify, intervalMs);
mcpServer.server.onclose = async () => { await stop(); };
```

## Two Notification Paths

### Primary: Channels push (recommended)

Requires starting Claude Code with the `--channels` flag:

```bash
claude --channels
```

When enabled, messages appear automatically in the agent's conversation as `<channel>` tags. The agent sees them and can act — no tool call to receive, no loop to maintain.

**Requirements:**
- Claude Code v2.1.80 or later
- claude.ai login (Console and API key authentication not supported)
- Team/Enterprise organizations must explicitly enable channels

Reference: [Channels documentation](https://code.claude.com/docs/en/channels), [Channels Reference](https://code.claude.com/docs/en/channels-reference)

### Fallback: `/loop` on `messaging_read_messages`

If the `--channels` flag is not used, tools still work normally. The server still polls and sends `notification()` calls over stdio, but Claude Code does not register a listener for them — the JSON-RPC messages are received and dropped. No errors are raised on either side. The agent (or user) can set up periodic polling as a fallback:

```
/loop 5m messaging_read_messages agent_id="my-agent" channel="coordination"
```

This is the existing behavior — no new code required. The `--channels` path is an upgrade, not a replacement.

## Graceful Degradation

| Scenario | Behavior |
|----------|----------|
| `--channels` enabled | Full push: messages appear as `<channel>` tags automatically |
| `--channels` not enabled | Tools work normally. Server still polls and sends `notification()` over stdio, but Claude Code drops the messages (no listener registered). No errors on either side. Use `/loop` on `read_messages` for periodic polling. |
| Agent has no cursors | No polling occurs — nothing to watch until agent reads a channel |
| SQLite busy (concurrent writes) | Polling query uses `busy_timeout` like all other queries. Transient failures are retried on next interval. |

## File Structure

### Remove

| File | Reason |
|------|--------|
| `src/pubsub.ts` | In-process pub/sub, dead in stdio model |
| `src/sessions.ts` | HTTP session manager, dead in stdio model |
| `tests/pubsub/pubsub.test.ts` | Tests for removed code |
| `tests/subscribe/subscribe.test.ts` | Tests for removed tool |
| `tests/server/server.test.ts` | HTTP server tests |
| `tests/e2e/subscribe-flow.test.ts` | Tests subscribe flow using removed pub/sub |

### Modify

| File | Change |
|------|--------|
| `src/server.ts` | Add channel capability, instructions, wire agent binding + background polling |
| `src/types.ts` | Replace `pubsub: PubSub` with optional `onAgentId` callback, remove `PubSub` import |
| `src/modules/messaging/index.ts` | Remove `messaging_subscribe` tool, replace `pubsub` with `onAgentId` callback, call `onAgentId` in handlers with `agent_id`, remove `onSend` from send_message handler |
| `src/modules/messaging/tools.ts` | Remove `subscribe()` function, remove `onSend` param from `sendMessage()` |
| `tests/messaging/module.test.ts` | Expect 7 tools (was 6), remove pubsub arg from registerTools |

### Create

| File | Purpose |
|------|---------|
| `src/channel.ts` | Background polling loop + channel notification push logic |
| `tests/channel/channel.test.ts` | Tests for polling behavior and notification emission |

## Testing Strategy

All tests run against real SQLite (temp files per test). No mocks except the notification callback.

### New tests (`tests/channel/channel.test.ts`)

- Polling finds unread messages and calls notification callback with correct format (content, meta with channel_name, sender, message_id)
- Polling skips messages sent by the subscribing agent (self-exclusion)
- Polling only checks channels where agent has cursors
- Polling does NOT advance cursors
- No polling starts until agent identity is established
- Duplicate prevention: same message is not notified twice across poll cycles
- Polling handles empty result (no cursors, no unread messages) without error
- `lastPushedId` initializes from cursor position, not 0 (no historical message flood on startup)
- New cursor mid-session: agent reads a new channel, next poll picks it up without flooding history
- Coalescing: multiple unread messages on same channel produce one notification (not N)
- Coalescing: more than 10 unread messages produce a single notification with accurate count
- Watermark only advances after notify resolves (simulated notify failure keeps watermark put)
- Serialization: overlapping poll ticks don't run concurrently
- Quiescent shutdown: `stop()` waits for in-flight tick to complete before resolving
- No duplicate push when cursor advances on another channel during in-flight notify

### How to test notifications

The `channel.ts` module accepts a `notify` callback. In production: wired to `mcpServer.server.notification()`. In tests: a spy function that captures calls.

```typescript
const notifications: any[] = [];
const notify = (content: string, meta: Record<string, string>) => {
  notifications.push({ content, meta });
};

startPolling(db, "agent-a", notify, 100); // fast interval for tests
```

### Existing tests (unchanged)

- `tests/messaging/send.test.ts` — sendMessage works (onSend param removed, no behavior change)
- `tests/messaging/read.test.ts` — readMessages works
- `tests/messaging/channels.test.ts` — channel creation works
- `tests/messaging/module.test.ts` — updated to expect 7 tools, registerTools called with 2 args
- `tests/messaging/binding.test.ts` — agent identity binding enforcement (reject mismatched agent_id before DB mutation)

### What we're NOT testing

- Claude Code's `--channels` flag behavior (their responsibility)
- Whether `<channel>` tags actually render in the conversation (manual smoke test)

## Decisions Log

| Decision | Choice | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Push mechanism | Claude Code Channels (`notifications/claude/channel`) | SSE notifications, MCP resource updates, long-poll tool | Only mechanism that injects content into agent context without a tool call. SSE/resource notifications not surfaced by Claude Code. |
| Transport | Stdio (unchanged) | HTTP, dual stdio+HTTP | Zero-setup, Claude Code manages lifecycle, plugin-distributable. No server to start. |
| Subscribe tool | Removed | Keep as DB-polling fallback | Half-way house between channels push and `/loop` fallback. Adds complexity without meaningful improvement over either path. |
| Polling location | Server-internal background loop | Agent-side tool call loop | Agent never loops. Server handles delivery, agent handles processing. Clean separation. |
| Cursor behavior | Push does NOT advance cursors | Push advances cursors | Prevents lost messages on crash/disconnect. Agent acks via `read_messages`. Same contract as previous designs. |
| Graceful degradation | Tools work without `--channels`, push silently ignored | Require `--channels` or fail | Maximum compatibility. `/loop` fallback available for sessions without channels. |
| Server API | McpServer (high-level) + `.server` for notifications | Low-level Server with setRequestHandler | Keep existing `server.tool()` pattern for tool registration. Access underlying Server only for notifications. |
| Polling interval | 3 seconds default | 1s, 5s, adaptive | 3s balances latency (1-3s delivery) with SQLite read load. Configurable via env var. |
| Agent binding mechanism | Optional `onAgentId` callback passed to `registerTools` | Module-level singleton, McpServer request interception, revert to 2-arg signature | Callback is explicit, testable, and keeps modules decoupled from server wiring. Module-level singletons are hard to test. Request interception requires accessing McpServer internals. A pure 2-arg signature has no clean way to communicate agent identity back to server.ts. |

## Future Considerations

- **Two-way channel (reply tool):** Add an MCP reply tool so agents can respond to channel messages directly through the channel protocol, instead of calling `messaging_send_message`. Defer until the one-way push is proven.
- **Permission relay:** Channel servers can opt into relaying tool approval prompts to remote devices. Could enable mobile approval of agent actions. Requires trusted sender gating.
- **Plugin marketplace:** Package octo-santa as a Claude Code plugin for `/plugin install`. Requires passing the approved channel allowlist review.
- **Subscription filtering:** Push notifications for specific channels only, not all channels with cursors. Add when channel count makes all-channel notification noisy.

## Human REPL Interaction

The human messaging REPL (`src/repl/`) allows humans to send and receive messages
through octo-santa channels without Claude in the loop. The REPL is a **human actor**,
not an agent — it does not call `registerAgent`, does not create DB cursor rows for
reading (uses in-memory tracking), and does not affect the DM/group notification mode.

The channel push member count query filters on `agents.pid IS NOT NULL`, so cursor
rows created by `sendMessage` for human senders are excluded. DM/group mode member
counting now also includes `last_seen_at` freshness per the agent lifecycle spec
(`2026-03-24-agent-lifecycle-and-membership.md`). See `docs/specs/2026-03-24-human-messaging-repl.md`
for the full REPL design.
