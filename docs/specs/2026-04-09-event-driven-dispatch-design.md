# Event-Driven Notification Dispatch — Design Spec

> Date: 2026-04-09
> Status: Implemented (with addendum — see §8)
> Authors: os-pm, os-tl

---

## 1. Problem

The current notification system uses a 3-second polling loop (`createClaudeNotifier`) that scans for undelivered messages via `getUndelivered()` with an in-memory high-water mark (HWM). This architecture has two bugs and unnecessary complexity:

- **Bug #7**: `subscribe()` initializes the read cursor to `maxId`, hiding all pre-existing messages from new subscribers.
- **Bug #8**: The read path and notification path share cursor state, causing races that suppress push notifications when an agent reads messages between poll ticks.

The original fix proposal (consumer-aware cursors) would put delivery tracking into core, violating hexagonal architecture boundaries.

## 2. Solution

Replace polling with event-driven dispatch: `MessagingService.send()` resolves mention targets and synchronously invokes a `NotificationDispatch` port. The dispatch adapter fans out to per-agent notification handlers registered by the transport layer.

Bug #7 is fixed by setting initial cursor to 0. Bug #8 is eliminated by construction — push no longer touches cursors.

## 3. Architecture

### 3.1 New Port: `NotificationDispatch`

Defined in `src/core/ports.ts`. The core service calls this; adapters implement it.

```typescript
export interface NotificationDispatch {
  dispatch(notification: {
    channelName: string;
    sender: string;
    content: string;
    messageId: number;
    isDm: boolean;
    targetAgents: string[];
  }): void;
}
```

- `targetAgents` is resolved by `MessagingService.send()` (domain logic stays in core)
- `dispatch()` returns `void` — core does not wait for delivery
- The dispatch adapter fire-and-forgets each `port.notify()` call with `.catch()` error logging

### 3.2 Target Resolution (in `MessagingService.send()`)

After `extractMentions()` and message insertion, `send()` resolves which agents to notify:

- `@agent-name` mention → include if agent is subscribed to the channel
- `@all` / `@here` (the `"*"` sentinel) → all channel subscribers except sender
- DM channels → the other party (always notified, no mention check)
- Sender is never notified of their own message

Core resolves targets to subscribed agent IDs. The dispatch adapter silently skips agents with no registered handler (agent exists but isn't connected). Two layers, each ignorant of the other's concern.

### 3.3 Notification Dispatch Adapter

New module replacing `src/notifications/claude-notifier/`. Location: `src/notifications/dispatch/`.

```typescript
export function createNotificationDispatcher(): NotificationDispatch & {
  register(agentId: string, port: NotificationPort): void;
  unregister(agentId: string): void;
} {
  const handlers = new Map<string, NotificationPort>();
  return {
    dispatch(notification) {
      for (const agentId of notification.targetAgents) {
        const handler = handlers.get(agentId);
        if (!handler) continue; // agent not connected — skip silently
        const meta = {
          channel_name: notification.channelName,
          sender: notification.sender,
          message_id: String(notification.messageId),
        };
        handler.notify(notification.content, meta)
          .catch(err => log(`dispatch failed for ${agentId}: ${err}`));
      }
    },
    register(agentId, port) { handlers.set(agentId, port); },
    unregister(agentId) { handlers.delete(agentId); },
  };
}
```

Key properties:
- `register` / `unregister` are NOT core ports — adapter-only API consumed by the transport layer
- No domain logic — pure delivery fanout
- No coalescing — one message, one dispatch, one notification per target agent
- `NotificationPort` interface is reused (existing `notify(content, meta)` contract)

### 3.4 MCP Transport Adapter Changes

In `src/transports/mcp-stdio/adapter.ts`:

**Options type changes:**
- Remove: `startNotifier: (agentId: string, port: NotificationPort) => () => Promise<void>`
- Add: `registerNotificationHandler: (agentId: string, port: NotificationPort) => void`
- Add: `unregisterNotificationHandler: (agentId: string) => void`
- Add: `agents: AgentRepository` (for heartbeat)

**`onAgentId()` commit callback:**
- Replace `stopPolling = startNotifier(agentId, port)` with `registerNotificationHandler(agentId, port)`
- Start heartbeat timer: `setInterval(() => agents.heartbeatOrReclaim(agentId, process.pid), heartbeatIntervalMs)`

**Disconnect handler:**
- Replace `await stopPolling?.()` with `unregisterNotificationHandler(boundAgentId)` + `clearInterval(heartbeatTimer)`
- Synchronous cleanup — no quiescent shutdown needed

**Heartbeat:**
- Moves from notifier to MCP adapter (transport/session concern, not notification concern)
- Interval configurable via `OCTO_SANTA_HEARTBEAT_INTERVAL_MS` env var, default 10s (was 3s when piggybacking on poll)

### 3.5 Composition Root (`main.ts`)

```typescript
const dispatcher = createNotificationDispatcher();

const messaging = new MessagingService(
  repos.agents, repos.channels, repos.messages, repos.cursors,
  process.pid, dispatcher  // new parameter
);

await startMcpStdio({
  messaging,
  brain, config, brainIndex,
  registerNotificationHandler: dispatcher.register.bind(dispatcher),
  unregisterNotificationHandler: dispatcher.unregister.bind(dispatcher),
  agents: repos.agents,
  onDisconnect: (agentId, pid) => {
    messaging.unregister(agentId);
    brain.onDisconnect(agentId, pid);
  },
});
```

### 3.6 Bug #7 Fix: Cursor Initialization

Two call sites change initial cursor from `maxId` to `0`:

1. **`subscribe()`** (service.ts ~line 61):
   ```typescript
   // Before:
   const maxId = this.channels.getMaxMessageId(channel.id);
   this.channels.addMember(agentId, channel.id, maxId);
   // After:
   this.channels.addMember(agentId, channel.id, 0);
   ```

2. **`directMessage()`** (service.ts ~line 138):
   ```typescript
   // Before:
   const maxId = this.channels.getMaxMessageId(channel.id);
   this.channels.addMember(agentId, channel.id, maxId);
   this.channels.addMember(targetAgentId, channel.id, maxId);
   // After:
   this.channels.addMember(agentId, channel.id, 0);
   this.channels.addMember(targetAgentId, channel.id, 0);
   ```

With event-driven push, cursors only serve the read path. cursor = 0 means first explicit read returns full channel history (capped by `limit`, default 100). This is the least surprising behavior — the old `maxId` was a workaround for polling flood prevention, now unnecessary.

### 3.7 Bug #8 Fix

Eliminated by construction. Push dispatches at send-time based on mentions, not cursors. No shared state between read and notification paths.

## 4. Dead Code Removal

| Item | Location | Reason |
|------|----------|--------|
| `getUndelivered()` | `MessagingService` (~lines 214-274) | Replaced by event-driven dispatch |
| `createClaudeNotifier()` | `src/notifications/claude-notifier/` (entire module) | Polling loop replaced by dispatch adapter |
| `PendingNotification` type | `src/core/messaging/types.ts` | Only used by `getUndelivered()` |
| `countSince()` | `MessageRepository` port + `SqliteMessageRepo` | Only used by `getUndelivered()` |
| `getMaxMessageId()` | `ChannelRepository` port + `SqliteChannelRepo` | Only used by `subscribe()` and `directMessage()`, both changing to 0 |

**Kept:** `readSince()` on `MessageRepository` — still used by `pollNewMessages()` (REPL).

## 5. ADR: Push Reliability Ownership

**Decision:** Push reliability is a per-transport adapter concern, not a core concern.

**Context:** Core dispatches events statelessly via `NotificationDispatch`. Each adapter owns its delivery semantics:
- MCP adapter (current): best-effort fire-and-forget. Missed notifications caught by `read_messages` pull.
- HTTP webhook adapter (future): adapter owns retry/delivery state inside the adapter layer.
- SSE adapter (future): transport resumability + optional adapter-local cursor.

**Consequences:** No delivery tracking in core. No HWM, no delivery cursors, no retry logic in `MessagingService`. The read cursor remains the sole position-tracking mechanism in core. Adapters that need delivery guarantees build their own.

## 6. What Stays Unchanged

- `insertAndJoinSender()` auto-join behavior (membership, not notification)
- Read path: `readForwardAndAdvance()`, `readBefore()`, `readRecent()`
- `extractMentions()` logic
- `pollNewMessages()` (REPL)
- All existing MCP tools (same API surface)
- `NotificationPort` interface (reused internally by dispatch adapter)
- Database schema (no migration needed)

## 7. Success Criteria

1. Existing messaging tests pass unchanged (backward compat)
2. Push notification fires synchronously on `send()` for mentioned/DM agents
3. Polling notifier loop, `getUndelivered()`, and in-memory HWM eliminated
4. Bug #7: new subscriber's first `messaging_read_messages` returns channel history (not empty)
5. Bug #8: active `messaging_read_messages` calls do not affect push notification delivery
6. Architecture: notification dispatch invoked from core, delivery logic lives in adapter
7. Read cursor remains the sole position-tracking mechanism in core
8. Heartbeat runs in MCP transport adapter, not notification layer

## 8. Postscript: What Actually Happened (2026-04-10)

This spec was implemented in commit `1122ada` (PR #9). All success criteria were
met — in isolation. The event-driven dispatch works correctly for in-process
delivery.

**The spec missed the cross-process case.** Each Claude Code agent runs in its own
subprocess. The dispatcher's in-memory `Map<string, NotificationPort>` only contains
the local process's agent. When Agent A (process 1) sends `@agent-b`, the dispatcher
in process 1 does `handlers.get("agent-b")` → `undefined` → silently skips. Agent B
(process 2) never receives a push notification.

The old polling notifier worked cross-process because each process independently
polled SQLite. This spec eliminated that cross-process bridge without replacement.

**Fix (commit `5deaf63`):** A cross-process SQLite poller was added alongside the
dispatcher. See [cross-process-notification-poller.md](2026-04-10-cross-process-notification-poller.md)
for the design. The poller is architecturally better than the old notifier (independent
HWM, simpler query, adapter-level filtering, no core coupling), but it is polling —
the thing this spec set out to eliminate.

**Success criteria #3 ("polling notifier loop eliminated") was not durably achieved.**
The old polling loop was eliminated, but a new (improved) polling loop was required
within 24 hours. The fundamental constraint: cross-process communication over shared
SQLite requires reading shared state, which means polling. Event-driven dispatch
solves same-process delivery but cannot cross the process boundary.

**The dispatcher is currently dead code.** Single agent per process, sender excluded
from targets — the dispatcher's `handlers.get()` never finds a match. It carries
optionality for future multi-agent-per-process transports (Phase 3b direct mode).
If that future doesn't arrive, it's 31 lines that can be deleted.

**What this spec got right:**
- Removing `getUndelivered()` from core (60 lines of adapter-shaped domain logic, gone)
- Fixing bugs #7 and #8 by construction (independent HWM, cursor decoupling)
- Establishing that push reliability is a per-transport adapter concern
- Moving heartbeat to the transport adapter

**What this spec got wrong:**
- Assuming event-driven dispatch is sufficient for the N-process deployment model
- Not accounting for the fact that SQLite is the only IPC bridge between processes
- Success criteria that claimed polling was eliminated as a durable outcome
