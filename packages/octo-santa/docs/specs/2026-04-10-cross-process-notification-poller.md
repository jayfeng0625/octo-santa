# Cross-Process Notification Poller — Design Spec

> Date: 2026-04-10
> Status: Approved
> Authors: os-tl, os-pm
> Channel: os-notification-bug

---

## 1. Problem

The event-driven notification dispatch (2026-04-09) replaced the old polling notifier with a per-process in-memory dispatcher. Each octo-santa process registers only the local agent's `NotificationPort` handler. When Agent A (process 1) sends a message targeting Agent B, the dispatcher in process 1 does `handlers.get("agent-b")` → `undefined` → silently skips. Agent B never receives a `notifications/claude/channel` push.

The old polling notifier (`createClaudeNotifier`) worked cross-process because each process independently polled the shared SQLite database. The event-driven dispatch removed this cross-process bridge without replacement.

Bug #7 (cursor init) and Bug #8 (read/push cursor sharing) fixes from the event-driven change must be preserved.

## 2. Solution

Add a lightweight cross-process poller in the notification adapter layer. Each process polls SQLite for new messages targeting its local agent across all subscribed channels, using an adapter-owned high-water mark (HWM) completely independent of the read cursor.

This is NOT the old notifier reintroduced. Key differences:

| Aspect | Old notifier | New poller |
|--------|-------------|------------|
| Cursor | Read cursor (shared with `read_messages`) → caused bug #8 | Adapter-owned HWM (independent) |
| Scope | `getUndelivered()` scanned per-channel with complex logic | Single cross-channel `id > HWM` query |
| HWM init | `maxId` on subscribe → caused bug #7 | `maxId` at adapter startup only; read cursor starts at 0 |
| Location | `src/notifications/claude-notifier/` (coupled to Claude) | `src/notifications/poller/` (transport-agnostic) |
| Mention filtering | In core (`getUndelivered`) | In adapter (reads pre-extracted `mentions` column) |

## 3. Architecture

### 3.1 Notification Query Port

Defined in `src/core/ports.ts` alongside other port interfaces, with a re-export in `src/notifications/ports.ts` for adapter convenience. Implemented by SQLite.

```typescript
// src/core/ports.ts (addition)
export interface NotificationQueryPort {
  getNewMessagesForAgent(
    agentId: string,
    sinceId: number,
    limit: number
  ): Array<Message & { channel_name: string }>;
  getMaxMessageId(): number;
}
```

**Why core ports?** The architecture boundary tests enforce `storage must not depend on notifications`. Since `SqliteNotificationQueryRepo` in `src/storage/sqlite/` implements this interface, it must import from `src/core/ports.ts` (not `src/notifications/`). This is consistent with the existing pattern — `NotificationPort` and `NotificationDispatch` already live in core ports.

### 3.2 SQLite Implementation

New class in `src/storage/sqlite/notification-query-repo.ts` implementing `NotificationQueryPort`.

`getNewMessagesForAgent` query:

```sql
SELECT m.*, c.name AS channel_name
FROM messages m
JOIN cursors cm ON cm.channel_id = m.channel_id AND cm.agent_id = ?
JOIN channels c ON c.id = m.channel_id
WHERE m.id > ? AND m.agent_id != ?
ORDER BY m.id ASC
LIMIT ?
```

- Joins `cursors` to scope to subscribed channels only (the `cursors` table tracks channel membership)
- Joins `channels` to get channel name (needed for DM detection)
- `agent_id != ?` excludes the agent's own messages (no self-notification)
- Single global HWM — message IDs are globally monotonic

`getMaxMessageId` query:

```sql
SELECT COALESCE(MAX(id), 0) AS max_id FROM messages
```

### 3.3 Cross-Process Poller

New module: `src/notifications/poller/poller.ts`

```typescript
export function createNotificationPoller(opts: {
  queries: NotificationQueryPort;
  port: NotificationPort;
  agentId: string;
  intervalMs?: number;
}): { start(): void; stop(): void }
```

Behavior:
1. On `start()`, initialize HWM to `queries.getMaxMessageId()`
2. Every `intervalMs` (default 2000ms), call `queries.getNewMessagesForAgent(agentId, hwm, 100)`
3. For each message, apply mention filter (section 3.4)
4. For notifiable messages, call `port.notify(content, meta)` with channel name, sender, and message ID
5. Advance HWM to the highest message ID seen (whether notified or not)
6. On `stop()`, clear the interval

The timer is `.unref()`'d so it doesn't prevent process exit.

Error handling: wrap each tick in try/catch, log errors, continue polling. Individual `port.notify()` failures are caught per-message (fire-and-forget with `.catch()` logging), same as the dispatcher.

### 3.4 Mention Filtering (Adapter Logic)

The poller applies delivery policy using the pre-extracted `mentions` column from each message:

```
IF channel_name matches DM pattern (isDmChannel):
  → NOTIFY (all DM messages push to both parties)
ELSE IF mentions JSON contains agentId or "*":
  → NOTIFY
ELSE:
  → SKIP (silent message, no push)
```

This is adapter-level delivery policy, not domain logic. Core extracts mentions at send time and stores them in the `mentions` column. The adapter reads that pre-extracted data. No duplication of `extractMentions()`.

### 3.5 Composition Root Changes (`main.ts`)

```typescript
import { createNotificationPoller } from "./notifications/poller/poller";
import { SqliteNotificationQueryRepo } from "./storage/sqlite/notification-query-repo";

// After repos creation:
const notificationQueries = new SqliteNotificationQueryRepo(db);

// Pass to startMcpStdio:
await startMcpStdio({
  ...existing opts,
  notificationQueries,
});
```

### 3.6 MCP Transport Adapter Changes

In `onAgentId.commit()`, after registering the notification handler, start the poller:

```typescript
const poller = createNotificationPoller({
  queries: notificationQueries,
  port,  // same NotificationPort used for the dispatcher
  agentId,
  intervalMs: 2000,
});
poller.start();
```

In `onclose`, stop the poller:

```typescript
poller.stop();
```

### 3.7 Coexistence with In-Process Dispatcher

Both mechanisms coexist:

- **Dispatcher**: synchronous, in-process delivery at send-time. Currently dead (single agent per process, sender excluded from targets). Ready for future multi-agent transports.
- **Poller**: async, cross-process delivery via SQLite. The actual fix.

No dedup between dispatcher and poller. In the theoretical same-process case, the agent would receive a duplicate `<channel>` tag. This is harmless:
- Agent calls `read_messages` once
- Messages deduped by ID
- No user-visible harm

Adding HWM coordination between dispatcher and poller would couple independent components for an edge case that doesn't exist today. YAGNI.

## 4. What Changes

| Item | Location | Change |
|------|----------|--------|
| `NotificationQueryPort` | `src/notifications/ports.ts` | New interface |
| `SqliteNotificationQueryRepo` | `src/storage/sqlite/notification-query-repo.ts` | New class |
| `createNotificationPoller` | `src/notifications/poller/poller.ts` | New module |
| `main.ts` | Composition root | Wire `notificationQueries`, pass to adapter |
| MCP adapter | `src/transports/mcp-stdio/adapter.ts` | Start/stop poller in `onAgentId`/`onclose` |

## 5. What Stays Unchanged

- `NotificationDispatch` port and in-process dispatcher (kept, coexists)
- `MessagingService.send()` dispatch call path
- Read cursor as sole position-tracking in core
- `readForwardAndAdvance()`, `readBefore()`, `readRecent()`, `readSince()`
- Bug #7 fix (cursor init to 0 in `subscribe`/`directMessage`)
- Bug #8 fix (push doesn't touch read cursors)
- All existing MCP tools
- Database schema (no migration needed — existing indexes sufficient)

## 6. Success Criteria

1. Cross-process notification delivery works: Agent A sends `@agent-b`, Agent B's Claude receives `<channel>` push within 2 seconds
2. DM notifications work cross-process
3. `@all` notifications work cross-process
4. Unmentioned messages in regular channels do NOT trigger push
5. Bug #7 preserved: new subscriber's `read_messages` returns channel history
6. Bug #8 preserved: `read_messages` calls do not affect push delivery
7. Adapter HWM is independent of read cursor
8. Existing tests pass unchanged

## 7. Addendum: Port Placement Correction (2026-04-11)

The implementation placed `NotificationQueryPort` in `src/core/ports.ts`. This
deviated from this spec, which defined it in `src/notifications/ports.ts` (section
4, table row 1). The deviation occurred because the boundary tests enforce "storage
must not depend on notifications" — the SQLite implementation needed to import the
interface, and core was the path of least resistance.

**Correction:** The named interface was removed from core entirely. The poller now
accepts raw query functions (`getNewMessagesForAgent`, `getMaxMessageId`) injected
via closures from `main.ts`. `SqliteNotificationQueryRepo` remains in storage as a
storage-internal class with no core port to implement.

This aligns with the architectural principle that core must be push-first.
`NotificationDispatch` is the sole notification interface in core — polling is an
adapter-level concern that should be swappable without touching core.
