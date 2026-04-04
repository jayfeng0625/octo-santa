# Brain Module + Messaging DM Support

Cross-domain knowledge layer for multi-repo agent collaboration. Agents
become queryable domain experts; other agents discover and DM them.

## Scope

Everything needed for the cross-domain query flow to work end-to-end:

- 6 brain tools, 2 tables, `.octo-santa/config.json` reading
- `OctoModule.onDisconnect` lifecycle hook
- `instructions` field + bootstrap notification for brain context
- `messaging_direct_message` (new tool)
- `messaging_read_messages` access control fix
- Path sandboxing for `brain.dirs`

Out of scope (separate spec): `messaging_rename_channel`,
`messaging_list_agents` active/stale filtering, agent table pollution
visibility, messaging single-purpose audit remediation.

## Config & Domain Registration

`.octo-santa/config.json` declares the repo's domain identity:

```json
{
  "domain": {
    "identifier": "payments-api",
    "tags": ["payments", "billing", "subscriptions"],
    "description": "Payment processing, webhook delivery, billing cycles"
  },
  "brain": {
    "dirs": ["./brain"]
  }
}
```

On MCP server startup, the brain module reads this from `process.cwd()`
and upserts into the `domains` table:

```sql
CREATE TABLE domains (
  identifier TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  tags TEXT NOT NULL,           -- JSON array
  description TEXT NOT NULL,
  registered_at INTEGER NOT NULL
);
```

- `identifier` is globally unique (PK). Two repos with same identifier =
  config mistake, human fixes it.
- Upsert by identifier — if the repo moves (CWD changes), the row updates.
- No config = brain module skips domain registration silently. Messaging
  works unchanged.
- Path sandboxing: `brain.dirs` must be relative paths within CWD. Reject
  absolute paths and `..` traversal.

## Brain Tools

Six MCP tools across three layers.

### Domain brain (local to the agent's repo)

| Tool | Input | Behavior |
|------|-------|----------|
| `brain_index` | none | Scans dirs from `brain.dirs` config, reads YAML frontmatter (title, summary, tags) from each `.md` file, returns MEMORY.md-style one-liner index. No config = empty result. |
| `brain_read` | `slug` | Maps slug to `<dir>/<slug>.md`, returns full file content. Error if not found. |

Brain doc frontmatter format:

```yaml
---
title: Webhook Schemas
summary: Payload formats for all outbound webhooks including retry
  behavior, signature verification, and event type taxonomy
tags: [webhooks, events, api-contracts]
---
```

`brain_index` output format:

```
- [./brain/webhook-schemas.md](webhook-schemas) — Payload formats for all outbound webhooks...
- [./brain/billing-cycles.md](billing-cycles) — Monthly/annual billing state machine...
```

### Shared brain (global, ~/.octo-santa/brain/)

| Tool | Input | Behavior |
|------|-------|----------|
| `brain_shared_index` | none | Same frontmatter scan, same output format, reads from shared brain dir. |
| `brain_shared_read` | `slug` | Same as `brain_read` but from shared brain dir. |

### Knowledge network (discovery + claiming)

| Tool | Input | Behavior |
|------|-------|----------|
| `brain_find_expert` | none | Returns all domain rows with `identifier`, `tags`, `description`, and an `active_sessions` array of agent IDs whose claimed PIDs are still alive (same liveness check as `messaging_list_agents`). Dead claims filtered at query time, not eagerly cleaned. No search param — LLM filters. |
| `brain_claim_domain` | `agent_id` | Links agent's session to this repo's domain. Validates `agent_id` matches the session's bound agent (same pattern as messaging tools). Requires prior `messaging_register` (validates PID in agents table). Inserts into `domain_claims`. |

Claims table:

```sql
CREATE TABLE domain_claims (
  agent_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  domain_identifier TEXT NOT NULL REFERENCES domains(identifier),
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, pid)
);
```

Unclaim is implicit — `onDisconnect` deletes by `(agent_id, pid)`. No
`brain_unclaim_domain` tool exists.

## OctoModule Lifecycle & Bootstrap

### onDisconnect hook

New optional method on the `OctoModule` interface:

```ts
export interface OctoModule {
  name: string;
  migrations: Migration[];
  registerTools: (...) => void;
  onDisconnect?: (db: Database, agentId: string, pid: number) => void;
}
```

`mcp.ts` onclose loops through all modules:
`for (const mod of modules) mod.onDisconnect?.(db, boundAgentId, process.pid)`

Cleanup order undefined for SLC — modules clean up independently.

- Brain's `onDisconnect`: `DELETE FROM domain_claims WHERE agent_id = ? AND pid = ?`
- Messaging's `onDisconnect`: existing `unregisterAgent` logic moves here
  to match the pattern.

### Bootstrap — two mechanisms, composing independently

1. **`instructions` field** on McpServer — extended with brain context
   (domain identity, tool descriptions). Survives context compaction.
   Brain module contributes its section alongside messaging's existing
   instructions.

2. **Channel notification** — the existing bootstrap notification in
   `mcp.ts` is extended to include brain context: domain identity, brain
   index (frontmatter scan), and a nudge to register then claim. One
   notification primes both messaging and brain.

### Startup sequence

1. MCP server spawns, inherits CWD
2. Brain module reads `.octo-santa/config.json` (if present)
3. Brain module upserts domain into SQLite
4. `instructions` field includes brain identity + tool descriptions
5. Bootstrap notification fires with messaging + brain context
6. Agent calls `messaging_register` (explicit)
7. Agent calls `brain_claim_domain` (explicit, opt-in)

Steps 6-7 are agent-driven tool calls, not implicit behavior.

## Messaging Additions

Two targeted changes — the minimum for the cross-domain query flow.

### New tool: messaging_direct_message

| Field | Value |
|-------|-------|
| Input | `agent_id`, `target_agent_id`, `content` |
| Behavior | Creates a DM channel with deterministic name (sorted: `agent-a,agent-b`), subscribes both agents, sends the message. Idempotent — if channel already exists, just sends. |

Both agents get push notifications (DM mode = 2 members = push all).
Auto-subscribing the target is by design — DMs auto-subscribe both
parties. DM auto-subscribe is inherent to the action (same rationale as
sender auto-subscribe in `messaging_send_message`) and is not subject to
Phase 2 remediation in the messaging-improvements spec.

### Fix: messaging_read_messages access control

**Current behavior:** `messaging_read_messages` calls `ensureAgent`
internally, which creates a cursor if one doesn't exist — making the
reader a member. An uninvited agent can read any DM channel by
constructing the name, and doing so bumps member count from 2→3,
flipping the channel from DM mode (push all) to group mode
(mention-only). One unsolicited read breaks notifications for both
original participants.

**Fix:** `messaging_read_messages` requires an existing cursor. No
cursor = error, not silent join. Agents join channels through explicit
subscription paths (`messaging_direct_message`, `messaging_create_channel`,
`messaging_send_message`), not by reading.

This fix adds the cursor check only. Phase 3 of the messaging-improvements
spec adds the separate `messaging_register` precondition.

## Cross-Domain Query Flow

The end-to-end flow that ties everything together:

```
Agent A (frontend repo)                    Agent B (payments repo)
───────────────────────                    ──────────────────────
Startup:                                   Startup:
  messaging_register("fe-impl")              messaging_register("be-impl")
  (no config, no claim)                      brain_claim_domain("be-impl")

1. brain_find_expert()
   → [{ identifier: "payments-api",
        tags: ["payments", "billing"],
        description: "Payment processing...",
        active_sessions: ["be-impl"] }]

2. messaging_direct_message("fe-impl",
     "be-impl", "How do webhooks retry?")
                                           3. Push notification arrives (DM mode)
                                           4. brain_index()
                                              → "- [webhook-schemas] — Payload formats..."
                                           5. brain_read("webhook-schemas")
                                           6. Replies in DM with answer

7. Reads reply, continues work
```

**No expert available:** If `brain_find_expert` returns a domain with no
`active_sessions`, the agent tells the user "payments-api domain exists
but no expert is online" — the human starts an agent in that repo. No
fallback, no degraded mode.

**Multiple experts:** Two agents can claim the same domain.
`brain_find_expert` returns all active sessions. The caller picks one
(skill-level decision).

## No-Config Behavior & Error Cases

An agent in a repo without `.octo-santa/config.json` is a first-class
citizen — it just can't be a domain expert.

### No-config tool behavior

| Tool | Behavior |
|------|----------|
| `brain_index` | Empty result (no brain dirs configured) |
| `brain_read` | Error: no brain dirs configured |
| `brain_shared_index` | Works (reads `~/.octo-santa/brain/`) |
| `brain_shared_read` | Works (reads `~/.octo-santa/brain/`) |
| `brain_find_expert` | Works (queries global domain registry) |
| `brain_claim_domain` | Error: no domain configured for this repo |

### Error cases

| Scenario | Behavior |
|----------|----------|
| `brain_claim_domain` before `messaging_register` | Error: must register first |
| `brain_read` with unknown slug | Error: doc not found |
| `brain.dirs` contains `..` or absolute path | Error: path must be relative and within CWD |
| Duplicate `domain.identifier` across repos | Last startup wins (upsert). Config mistake — human resolves. |
| Malformed config JSON | Brain module logs warning, skips registration, tools degrade as no-config |
| Shared brain dir doesn't exist | `brain_shared_index` returns empty, `brain_shared_read` errors on specific slug |
