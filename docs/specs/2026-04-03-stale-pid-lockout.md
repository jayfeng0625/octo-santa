# Stale PID Lockout — Notification Delivery Failure

**Issue:** [#2](https://github.com/jayfeng0625/octo-santa/issues/2)
**Date:** 2026-04-03

## Problem

When an MCP server process restarts (new PID) and the agent skips `messaging_register` — going directly to `messaging_send_message` or `messaging_read_messages` — the agent becomes permanently locked out of notifications while remaining fully functional for tool calls.

### Root cause

Two code paths interact to create the lockout:

1. **`ensureAgent()` cannot update the agent row.** The `ON CONFLICT DO UPDATE` has a WHERE clause `pid IS NULL OR pid = ?` scoped to `process.pid`. When the DB holds a dead PID from the previous process, the new process's PID doesn't match, so the UPDATE is silently skipped. The agent row retains the stale PID and stale `last_seen_at`.

2. **The polling heartbeat kills polling on PID mismatch.** `startPolling()` runs `UPDATE agents SET last_seen_at = ? WHERE id = ? AND pid = ?`. When this matches 0 rows (stale PID ≠ current PID), the fallback check sees `row.pid !== null && row.pid !== process.pid` and sets `active = false`, permanently stopping the polling loop.

### Evidence from production DB

| Agent   | DB PID | PID alive? | last_seen_at     | Stale by |
|---------|--------|------------|------------------|----------|
| agent-1 | 54594  | DEAD       | 2026-04-02 20:55 | 988 min  |
| agent-2 | 55120  | DEAD       | 2026-04-03 08:46 | 277 min  |

Both agents continued sending/reading messages via tools, but received zero push notifications. `list_members` showed both as `active: false`.

## Design

Two changes, defense-in-depth. Either alone would fix the immediate bug; together they prevent regression.

### Change 1: `ensureAgent()` reclaims dead PIDs

**File:** `src/modules/messaging/tools.ts`, `ensureAgent()` function (line 162)

Current behavior: single SQL upsert with `WHERE pid IS NULL OR pid = ?`. Silently skips update when stored PID belongs to a different (possibly dead) process.

New behavior:
1. Attempt the existing upsert (unchanged SQL, fast path).
2. Read the agent row to check the stored PID.
   - If stored PID is NULL or matches `process.pid`: done (fast path succeeded).
   - If stored PID differs: call `isProcessAlive(storedPid)`.
     - Dead → `UPDATE agents SET pid = ?, last_seen_at = ? WHERE id = ? AND pid = ?` (old PID in WHERE for CAS safety).
     - Alive → do nothing (another active session owns this agent — existing behavior).

The follow-up SELECT is a cheap primary-key lookup. The liveness check only runs on PID mismatch, which is the crash-restart edge case.

### Change 2: Heartbeat verifies liveness before killing polling

**File:** `src/channel.ts`, `tick()` function (line 62)

Current behavior: when `heartbeat.changes === 0` and stored PID differs from `process.pid`, immediately sets `active = false` and stops polling permanently.

New behavior: before setting `active = false`, call `isProcessAlive(row.pid)`:
- If the stored PID is alive: stop polling (real takeover by another process — existing behavior).
- If the stored PID is dead: attempt CAS reclaim (`UPDATE ... WHERE id = ? AND pid = old_pid`).
  - If reclaim succeeds (`changes > 0`): continue polling.
  - If reclaim fails (`changes === 0`): another process won the race — stop polling.

This prevents stale PIDs from false-positive killing the polling loop, while ensuring only one process wins a concurrent reclaim.

## Scope

### Changed
- `src/modules/messaging/tools.ts` — `ensureAgent()`: add dead-PID reclamation fallback
- `src/channel.ts` — `tick()`: add `isProcessAlive()` guard before stopping polling

### Not changed
- `registerAgent()` — already handles stale PIDs correctly
- Database schema — no migrations needed
- Cursor logic, notification delivery, member count queries — untouched

## Testing

### Unit tests
- `ensureAgent()` with dead PID in DB → verify PID takeover and `last_seen_at` update
- `ensureAgent()` with alive PID from different process → verify no takeover (existing behavior preserved)
- `ensureAgent()` with matching PID → verify normal update (existing behavior preserved)
- `ensureAgent()` with NULL PID → verify normal insert/update (existing behavior preserved)
- Heartbeat with dead PID → verify polling continues and PID is reclaimed
- Heartbeat with alive PID from different process → verify polling stops (existing behavior preserved)

### Integration test
- Register agent in process, simulate PID death (update DB to stale PID), start polling with new PID, send message from another agent → verify notification is delivered.
