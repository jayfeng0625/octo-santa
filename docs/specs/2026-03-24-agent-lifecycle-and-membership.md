# Agent Lifecycle and Channel Membership

> Extends [2026-03-23-agent-identity-and-targeting](2026-03-23-agent-identity-and-targeting.md).
> Supersedes the following from that spec:
> - **PID staleness window**: 1 hour → 15 minutes (now a crash-recovery backstop, not the primary cleanup)
> - **DM/group member counting**: adds `last_seen_at` freshness to the existing `pid IS NOT NULL` filter
>
> Preserves unchanged:
> - **Reconnect invariant**: "Re-registering with the same name reclaims the existing agent row — cursors and message history are preserved"
> - Agent naming, @mention parsing, DM/group mode semantics, bootstrap nudge

## Problem

The messaging module has four gaps:

1. **Stale agents** — `messaging_list_agents` returns every agent ever registered, with no way to tell who's actually online.
2. **Name hostage** — a crashed MCP session holds an agent name for up to 1 hour (PID staleness window) before anyone can reclaim it.
3. **Phantom channel members** — disconnected agents retain PID-bearing rows, tipping channels from DM mode (2 members, no mentions required) into group mode (3+, mentions required), breaking notification behavior.
4. **No membership visibility** — agents cannot discover who is subscribed to a channel without broadcasting and waiting for responses.

## Terminology

- **Agent row** — a row in the `agents` table. Created by `registerAgent` (with PID) or `ensureAgent` (without PID, lightweight).
- **Registered agent** — an agent row with `pid IS NOT NULL` and `registered_at IS NOT NULL`. Created by explicit `messaging_register` calls.
- **Active agent** — a registered agent that passes the full liveness check (`isAgentActive`): PID set, process alive, and `last_seen_at` within the staleness window.
- **Channel member** — an agent with a cursor row for that channel. Created implicitly by `sendMessage`, `readMessages`, or `subscribeToChannel`. This is a DB-tracked concept; REPL users who only read via in-memory cursors are not visible as members unless they've sent a message.

## Design

### Approach

Lifecycle events on the existing agent/cursor primitives. No new tables or migrations.

The core insight: **liveness-aware membership evaluation replaces physical cleanup**. Cursors are preserved across disconnects so that reconnecting agents retain their channel subscriptions and unread backlog. Membership queries derive "active" status from agent liveness, so dead agents stop affecting DM/group mode without deleting any rows.

This preserves the established invariant from the agent identity spec: "Re-registering with the same name reclaims the existing agent row — cursors and message history are preserved."

### `isAgentActive(agent): boolean`

New shared helper in `tools.ts`. Encapsulates the liveness check for agent presence:

1. `pid` is not null
2. `isProcessAlive(pid)` returns true
3. `last_seen_at` is within the staleness window (`PID_STALE_MS`)

All three must be true. Reused by `registerAgent` (conflict detection), `listAgents(active_only)`, and `listChannelMembers`.

### Liveness tiers

Two tiers of liveness checks exist, used in different contexts:

- **Exact liveness** (`isAgentActive`): PID not null + `isProcessAlive(pid)` + `last_seen_at` freshness. Used by `listAgents(active_only)`, `listChannelMembers`, and `registerAgent` conflict detection. Involves a syscall per agent.
- **Approximate liveness** (SQL-only): `pid IS NOT NULL AND last_seen_at > (now - PID_STALE_MS)`. Used by `channel.ts` DM/group mode member counting in the polling loop, where per-tick syscalls per member are too expensive. A dead-but-fresh PID may count as active for up to 15 minutes until `last_seen_at` ages out.

This divergence is intentional. Polling runs every 3 seconds across all subscribed channels; exact liveness would add O(members) syscalls per tick. The 15-minute approximate window is acceptable because DM/group mode is a notification optimization, not a security boundary.

### `unregisterAgent(db, agentId, expectedPid)`

New internal function in `tools.ts`. **Not exposed as an MCP tool.** Called only by the transport lifecycle (`onclose` in `mcp.ts`).

Ownership-scoped: only clears PID if the current value matches `expectedPid`. This prevents a late `onclose` from session A from clobbering session B's active registration after B has reclaimed the same agent name.

Single atomic UPDATE with a WHERE clause:
```sql
UPDATE agents SET pid = NULL, registered_at = NULL WHERE id = ? AND pid = ?
```
If the PID doesn't match (name already reclaimed by another session), the WHERE clause matches zero rows — a safe no-op.

**Cursors are not deleted** — channel subscriptions and unread backlog survive for reconnection.

The agent row remains for foreign key integrity — both `messages.agent_id` and `channels.created_by` reference `agents.id`.

Since PID is nulled, `isAgentActive` returns false, which means the agent immediately stops counting toward DM/group mode membership and stops appearing in active-only queries.

**Automatic cleanup:** `mcp.ts` `onclose` handler calls `unregisterAgent(db, boundAgentId, process.pid)` on MCP disconnect, guarded by a null check on `boundAgentId` (session may close before registration).

### Name reclaim

With proper unregister, the agent row has `pid = NULL`. `registerAgent` already skips the PID liveness check when `existing.pid` is null, so reconnection is immediate — no staleness wait.

### PID staleness window

Shortened from 1 hour to 15 minutes. This is now purely a crash-recovery backstop for cases where `onclose` never fires (SIGKILL, power loss). The primary cleanup path is the `onclose` unregister.

### `listChannelMembers(db, channelName)`

New function in `tools.ts`. Joins `cursors` with `agents` for the given channel. Returns **all DB-tracked channel members** (cursor holders) with an `active` flag:

```ts
interface ChannelMember {
  agent_id: string;
  active: boolean;
}
```

The `active` flag is computed by calling `isAgentActive` (exact liveness) per member in application code.

Note: this only reflects DB-tracked membership. REPL users who read via in-memory cursors without sending are not visible. REPL users who have sent a message appear with `active: false` (no PID).

**MCP tool:** `messaging_list_members` — takes `channel` name, returns member list with active status.

### `listAgents` active_only filter

`listAgents` gains an optional `active_only` parameter:

- `false` (default) — returns all agent rows (preserves current behavior).
- `true` — filters to agents where `isAgentActive` (exact liveness) returns true.

**MCP tool:** `messaging_list_agents` gains optional `active_only` boolean input.

### DM/group mode member counting

`channel.ts` `stmtMemberCount` is updated to use approximate liveness: `pid IS NOT NULL AND last_seen_at > ?` (where `?` is `now - PID_STALE_MS`). Currently it only checks `pid IS NOT NULL`; adding the freshness check ensures crashed agents age out of the member count within 15 minutes.

### Server instructions

Updated in `mcp.ts` to mention `messaging_list_members`.

### REPL

Add `/members` command to `src/repl/commands.ts` — calls `listChannelMembers` for the active channel and displays the member list.

## Scope

### Changes

| File | Change |
|------|--------|
| `src/modules/messaging/types.ts` | Add `ChannelMember` interface |
| `src/modules/messaging/tools.ts` | Add `isAgentActive`, `unregisterAgent`, `listChannelMembers`; add `active_only` param to `listAgents`; shorten `PID_STALE_MS` to 15 min; refactor `registerAgent` to use `isAgentActive` |
| `src/modules/messaging/index.ts` | Add `messaging_list_members` tool; update `messaging_list_agents` with `active_only` input |
| `src/mcp.ts` | Call `unregisterAgent` in `onclose` (with null guard and `process.pid`); update server instructions |
| `src/channel.ts` | Update `stmtMemberCount` to include `last_seen_at` freshness check |
| `src/repl/commands.ts` | Add `/members` command |

### Not changed

- **Schema/migrations** — no new tables or columns needed.

## Lifecycle contracts

| Scenario | PID | Cursors | Name available | Backlog |
|----------|-----|---------|----------------|---------|
| **Graceful disconnect** (`onclose`) | Nulled (if PID matches) | Preserved | Immediately reclaimable | Preserved |
| **Crash** (no `onclose`) | Stale (set) | Preserved | Reclaimable after 15 min or when PID dies | Preserved |
| **Reconnect** (same name) | New PID set | Existing cursors intact | Already owned | Unread messages waiting |

## Tests

### `unregisterAgent`

- Nulls PID and registered_at when expectedPid matches, preserves agent row
- No-op when expectedPid doesn't match (late `onclose` after name reclaim)
- Cursors survive unregister — subscriptions and unread backlog intact
- Name reclaim: register → unregister → register with same name succeeds immediately
- Message attribution: messages still reference agent_id after unregister
- Agent no longer counts in DM/group mode after unregister

### `isAgentActive`

- Returns true when PID is set, alive, and last_seen_at is fresh
- Returns false when PID is null
- Returns false when PID is set but process is dead
- Returns false when PID is set, alive, but last_seen_at exceeds staleness window

### `listChannelMembers`

- Returns all cursor holders with correct active flag
- Unregistered agents show as `active: false`
- Reconnected agents show as `active: true`
- Returns empty list for nonexistent channel
- REPL-only senders appear with `active: false`

### `listAgents` with `active_only`

- `active_only: false` returns all agents (backward compatible)
- `active_only: true` excludes unregistered and dead-PID agents

### DM/group mode recovery

- 3 agents in channel (group mode) → one unregisters → channel drops to 2 active → reverts to DM mode (no mentions required)
- Crashed agent (stale PID) stops counting after staleness window ages out `last_seen_at`

### Reconnect behavior

- Agent disconnects (unregister) → messages sent to channel while offline → agent reconnects → unread backlog available via `readMessages`
- Agent reconnects → polling resumes on previously subscribed channels

### Crash recovery

- Agent crashes (PID set but process dead) → `isProcessAlive` returns false → name is immediately reclaimable (no staleness wait needed for dead PIDs)
- Agent crashes but PID is reused by OS (alive, stale `last_seen_at`) → name is reclaimable after 15 min when `last_seen_at` ages out
- Crashed agent's cursors survive — backlog preserved for reconnect

### Late `onclose` race

- Session A registers as "planner" (pid 100) → Session A disconnects slowly → Session B reclaims "planner" (pid 200) → Session A's `onclose` fires `unregisterAgent("planner", 100)` → no-op because pid is now 200 → Session B unaffected
