# Messaging Tools Improvement

Remediation of implicit side effects in messaging tools, plus new tools
for channel management. Absorbs the messaging single-purpose audit
findings. Three phases organized by risk — all phases specced here,
implementation timing is a planning concern.

## Design Principle

MCP tools should be single-purpose atoms with no side effects. Composition
and workflow belong in skills and code, not baked into tool behavior.

## Scope

**Phase 1: Visibility (low risk, high value)**
- `messaging_list_agents` active/stale filtering
- `messaging_rename_channel` (new tool, members only)

**Phase 2: Explicit Subscription (medium risk)**
- `messaging_create_channel` — remove auto-subscribe
- `messaging_subscribe` (new tool)
- `messaging_send_message` — keeps sender auto-subscribe (inherent)

**Phase 3: Remove ensureAgent (higher risk)**
- Require `messaging_register` before send/read
- Remove `ensureAgent` fallback entirely
- Skills handle onboarding workflow

## Why This Matters

1. **Agent table pollution.** `ensureAgent` creates rows that never get
   cleaned up. `messaging_list_agents` becomes a graveyard of ad-hoc
   names like `backend-1`, `be-3`, `fe-1-tests`.
2. **Brain module sets a precedent.** Brain tools are strict atoms. Having
   messaging tools violate the same principle creates inconsistency.
3. **Skills need predictable tools.** If `messaging_send_message` has 4
   implicit operations, a skill can't reason about what state changed.
4. **Discovery noise.** `brain_find_expert` and `messaging_list_agents`
   both surface agent data. Stale rows pollute discovery results.

## Phase 1: Visibility

### messaging_list_agents — active/stale filtering

**Current behavior:** Returns all agent rows ever created, including
stale entries from `ensureAgent` side effects.

**Change:** Default to showing only agents with an active PID (heartbeat
within threshold). New optional param `include_stale: boolean` (default
`false`) to show all.

Active = PID exists and process is alive (same liveness check
`registerAgent` already uses). Stale rows persist for message history
attribution — hidden from discovery, not deleted.

### messaging_rename_channel (new tool)

| Field | Value |
|-------|-------|
| Input | `agent_id`, `channel`, `new_name` |
| Behavior | Renames a channel. Agent must have a cursor in the channel (membership check). Notifies all members. |

Use case: a DM evolves into a group conversation — invite more agents,
rename to something meaningful.

## Phase 2: Explicit Subscription

### messaging_create_channel — remove auto-subscribe

**Current behavior:** Creates the channel AND subscribes the creator via
`subscribeToChannel`. Two operations bundled.

**Change:** `messaging_create_channel` only creates the channel. Creating
and joining are separate actions. The agent subscribes explicitly if it
wants to participate.

### messaging_subscribe (new tool)

| Field | Value |
|-------|-------|
| Input | `agent_id`, `channel` |
| Behavior | Creates a cursor for the agent in the channel. Agent starts receiving push notifications. Error if channel doesn't exist. |

This is the explicit version of what was previously implicit in create,
send, and read.

### messaging_send_message — keeps sender auto-subscribe

Sending to a channel implies participation. This side effect is inherent
to the action — you don't send a message to a channel you're not part of.
The auto-subscribe on send stays.

The distinction: creating a channel or reading one are observation actions.
Sending is a participation action. Only participation auto-subscribes.

Post-remediation mechanics: `messaging_send_message` upserts a cursor for
the sender in an existing channel. Errors if the channel doesn't exist —
no implicit channel creation. The implicit `createChannel` call inside
`sendMessage` is removed alongside `ensureAgent` in Phase 3.

## Phase 3: Remove ensureAgent

### Current behavior

`ensureAgent` is called internally by `sendMessage` and `readMessages`.
Creates an agent row without PID ownership — a lightweight upsert that
bypasses `registerAgent`'s exclusive lock and liveness check. An agent
can appear in `messaging_list_agents` without ever calling
`messaging_register`. This is the primary source of agent table pollution.

### Change

Remove `ensureAgent` and implicit `createChannel` from the send and read
paths entirely. Both `messaging_send_message` and `messaging_read_messages`
require a prior `messaging_register` call — validated by checking the
agent has a PID-bound row in the agents table. No PID = error.
`messaging_send_message` also requires the channel to already exist —
no implicit channel creation.

### What this breaks

Zero-ceremony messaging. Today an agent can send a message as its first
action. After this change, the sequence is register → send. Skills handle
this onboarding: "You must call `messaging_register` before using any
messaging tools."

### What this fixes

- No more phantom agent rows from side effects
- `messaging_list_agents` is clean by default — every row represents an
  agent that explicitly registered
- Phase 1's active/stale filtering becomes less critical (still useful
  for agents that registered then disconnected)

### Migration

Existing stale rows from `ensureAgent` remain in the table. No cleanup
migration — they're harmless, hidden by Phase 1's filtering, and needed
for message history attribution.

## Tool Audit Summary

Before/after view of every messaging tool affected across all phases.

### Tools with changes

| Tool | Current Side Effects | After Remediation |
|------|---------------------|-------------------|
| `messaging_send_message` | Creates channel, creates agent row (`ensureAgent`), auto-subscribes sender, extracts mentions, sends | Requires prior register (Phase 3), auto-subscribes sender (kept), extracts mentions, sends. No channel creation, no `ensureAgent`. |
| `messaging_read_messages` | Creates agent row (`ensureAgent`), auto-subscribes reader | Requires prior register (Phase 3), requires existing cursor (fixed in brain spec). Pure read. |
| `messaging_create_channel` | Creates channel, auto-subscribes creator | Creates channel only (Phase 2). |
| `messaging_list_agents` | Returns all rows | Defaults to active only, `include_stale` option (Phase 1). |

### New tools

| Tool | Phase | Purpose |
|------|-------|---------|
| `messaging_subscribe` | 2 | Explicit channel subscription |
| `messaging_rename_channel` | 1 | Rename channel, members only |

### Tools unchanged

| Tool | Assessment |
|------|-----------|
| `messaging_register` | Single purpose. No changes. |
| `messaging_list_members` | Pure read. No changes. |
| `messaging_list_channels` | Pure read. No changes. |
| `messaging_direct_message` | New in brain spec. Designed as atom from the start. |

### Internal functions removed

| Function | Phase | Replacement |
|----------|-------|-------------|
| `ensureAgent` | 3 | Precondition check: agent must have PID-bound row |
| `subscribeToChannel` (auto in create) | 2 | Explicit `messaging_subscribe` tool |
