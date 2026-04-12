---
title: Persistent Agent Profiles
summary: Declarative YAML profiles for agent identity, concurrency control, and pool-wide addressing
tags: [profiles, agent-identity, concurrency, safety, governance]
---

# Persistent Agent Profiles — Design Spec

> Date: 2026-04-12
> Status: Approved
> Authors: os-tl, os-pm
> Channel: os-feature-roadmaps

---

## 1. Problem

octo-santa agents have names but not identities. Three concrete problems:

**No persistent identity.** Agent behavior (persona, objectives, role boundaries)
is not defined anywhere in octo-santa. Each session starts blank. An agent called
`os-pm` today has no connection to the `os-pm` of yesterday — no persona, no
objectives, no behavioral consistency across sessions.

**No concurrency control.** The `ensureAgent`/`registerAgent` split allows two
sessions to bind the same agent name simultaneously — one unowned (via `ensureAgent`
from `send`/`read`/`createChannel`), one owned (via `registerAgent` from
`messaging_register`). There's no mechanism to say "os-pm should only ever have one
instance" or "os-dev can have up to 4 concurrent instances."

**No governance layer.** The existing roadmap (Phase 0–4) builds capabilities —
what agents CAN do. Nothing answers who IS this agent, what SHOULD it do, or how
many can run at once. Profiles fill this gap as the declarative governance layer.

## 2. Goals

- Declarative agent identity: name, persona, objective, defined in YAML
- Concurrency control: singleton agents (max 1 instance) and pool agents (max N,
  auto-enumerated)
- Profile-informed registration: `messaging_register` validates against profiles,
  enforces concurrency limits, resolves registered names
- Pool-wide @mentions: `@os-dev` reaches all live instances of the `os-dev` profile
- Agent discovery: `messaging_list_agents` exposes persona and objective
- Backward compatibility: agents without profiles behave exactly as they do today
- Clean hex arch: core types + port, filesystem adapter, no profile-specific
  coupling to SQLite or YAML

## 3. Non-Goals

- **Sandboxing / filesystem isolation.** That's the plugin ecosystem feature
  (Feature 3), governed by a separate ADR on where enforcement lives.
- **Skill assignment per profile.** Also Feature 3 territory — profiles define
  identity, not capabilities.
- **Runtime profile mutation / hot reload.** Profiles are checked at registration
  time only. Running agents are not evicted when profiles change.
- **`requireProfiles` strict mode.** Profiles are opt-in. A global flag to require
  them is a future tightening knob.
- **Per-org/team configuration.** Parked until triggered by real multi-team
  deployment pain (Feature 1).
- **Profile search/filter API.** `messaging_list_agents` exposes persona/objective
  as flat fields. Callers scan the list themselves.

## 4. Design Decisions and Rationale

Decisions made during os-tl / os-pm deliberation in `os-feature-roadmaps` channel.

| # | Decision | Resolution | Rationale |
|---|----------|-----------|-----------|
| 1 | Naming strategy | Singletons use base name (`os-pm`), pools enumerate from `-1` (`os-dev-1`, `os-dev-2`) | Consistent, predictable. `@os-dev-2` unambiguously targets one instance. Singleton is the natural special case — pool of 1 doesn't need enumeration. |
| 2 | Slot reclamation | Lowest available slot from dead PIDs first, then next slot | Reuses existing `isProcessAlive()` pattern. Keeps numbering dense. No new machinery. |
| 3 | Race conditions | SQLite EXCLUSIVE transaction, existing `withRetrySync()` retry pattern | Second writer retries, re-checks slots, gets next available or rejected. No new locking. |
| 4 | Hex arch placement | Core defines `AgentProfile` type + `ProfileRepository` port. YAML filesystem adapter implements it. SQLite tracks runtime state. | Core doesn't know about YAML. Adapter conforms to port. Config vs. state separation is clean. |
| 5 | Unregistered agents | Permissive — allow registration without a profile (current behavior preserved) | Backward compatible (principle 5). Profiles are opt-in governance. Incremental adoption. |
| 6 | Profile storage | YAML on filesystem, not SQLite | Profiles are configuration, not runtime state. Version-controllable, human-editable, readable without a running instance. |
| 7 | Phase scope | Separate spec from loop guards, same milestone, independently shippable | Orthogonal safety mechanisms, same theme. Neither blocks the other. Avoids "waiting for the slower half." |
| 8 | Profile discovery | Expose persona/objective in `messaging_list_agents` response | Nearly free — columns already on the agent row. "Agent yellow pages" for capability discovery. |
| 9 | API change | Additive return value on `messaging_register`, not breaking | Existing callers unaffected. `registeredName` is the canonical identity — document prominently. |
| 10 | autoJoinChannels | Subscribe on register, structured success/failure in response | No create-on-demand (ownership ambiguity). No silent failure (debugging hell). Explicit is cheap. |
| 11 | Runtime mutation | Registration-time check only, no eviction, no file watcher | Config tightens organically as instances exit. No hot reload complexity. `ocs profiles reload --enforce` is future work (Phase 2 CLI). |
| 12 | Pool-wide mentions | `@base-name` mentions all live instances of that profile | Natural expectation for pools. Without it, pools are just numbered singletons. Both raw mention and expanded targets stored. |
| 13 | Zero-alive pool mention | Store message, zero notifications, instance sees it on next `read_messages` | Channel is already durable. No "pending mention" queue. Consistent with "messages are never lost" invariant. |
| 14 | Suffixed namespace reservation | Names matching `{profile_base_name}-\d+` are reserved when a profile exists. Exact profile match takes priority, then reservation check, then allow without profile. | Prevents silent overwrites of rogue agents by pool slot assignment. Guides users to register via the base name. |

## 5. Profile Schema

Profiles live in a configurable directory (default: alongside the database at
`~/.octo-santa/profiles/`). Each profile is a single YAML file named after the
base agent name.

### 5.1 Format

```yaml
# profiles/os-pm.yaml
name: os-pm
persona: >
  Product manager for octo-santa. Owns roadmap, prioritization,
  and stakeholder alignment. Reviews specs for scope and strategic fit.
objective: >
  Keep the project focused on north star principles.
  Challenge scope creep. Ensure features serve real user needs.
maxInstances: 1
autoJoinChannels:
  - os-roadmaps
# brainDomains deferred from v1 — see section 10.2
```

```yaml
# profiles/os-dev.yaml
name: os-dev
persona: >
  Developer agent for octo-santa. Implements features, fixes bugs,
  writes tests. Works within assigned task boundaries.
objective: >
  Ship correct, tested code that follows architecture principles.
maxInstances: 4
autoJoinChannels:
  - coordination
```

### 5.2 Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | yes | — | Base agent name. Must match `[\w-]+`. File name must match (`os-pm.yaml` → `name: os-pm`). |
| `persona` | string | no | `null` | Free-text agent persona/description. Stored on agent row, exposed in `messaging_list_agents`. |
| `objective` | string | no | `null` | Free-text agent objective. Stored on agent row, exposed in `messaging_list_agents`. |
| `maxInstances` | integer | no | `1` | Maximum concurrent live instances. `1` = singleton, `N > 1` = pool with auto-enumeration. |
| `autoJoinChannels` | string[] | no | `[]` | Channels to subscribe to on successful registration. |

Note: `brainDomains` was cut from v1. `BrainService.claimDomain()` only
claims the repo's configured domain — arbitrary profile domains would require a new
BrainService API. Deferred to Phase 4 (Brain Evolution). Unknown fields in YAML (including
`brainDomains`) are warn-and-ignore, so profiles with this field are forward-compatible.

### 5.3 Validation

- `name` must pass `validateAgentName()` (existing function in `core/utils.ts`)
- `name` must not be a reserved name (`all`, `here`, `_system`)
- `maxInstances` must be a positive integer (>= 1)
- File name (without `.yaml`) must equal the `name` field
- Duplicate `name` across files is an error (detected at load time)

### 5.4 Configuration

The profiles directory is configured via environment variable or config:

```
OCTO_SANTA_PROFILES_DIR=~/.octo-santa/profiles
```

If the directory doesn't exist or is empty, the system operates without profiles
(current behavior). No error, no warning — profiles are opt-in.

Different MCP server entries can specify different profile directories via this
env var, matching the existing multi-database pattern (`OCTO_SANTA_DB`) for team
isolation. This means separate MCP entries already give you separate databases
and now separate profile sets — no first-class per-org config needed.

## 6. Data Model Changes

### 6.1 Agent Table Migration

```sql
-- messaging_003_agent_profiles
ALTER TABLE agents ADD COLUMN base_name TEXT;
ALTER TABLE agents ADD COLUMN persona TEXT;
ALTER TABLE agents ADD COLUMN objective TEXT;
CREATE INDEX idx_agents_base_name ON agents(base_name);
```

All three columns are nullable. Existing rows have `NULL` values — no backfill,
no breakage.

### 6.2 Column Semantics

| Column | Source | Description |
|--------|--------|-------------|
| `id` | Registration | The registered name: `os-pm` (singleton) or `os-dev-2` (pool instance) |
| `base_name` | Profile lookup | The profile name: `os-pm` or `os-dev`. `NULL` for agents without a profile. |
| `persona` | Profile YAML | Copied from profile at registration time. `NULL` for agents without a profile. |
| `objective` | Profile YAML | Copied from profile at registration time. `NULL` for agents without a profile. |
| `pid` | Registration | OS process ID of the owning process. |
| `registered_at` | Registration | Timestamp of last registration or reclaim. |
| `last_seen_at` | Heartbeat | Timestamp of last heartbeat. |

The `base_name` index enables efficient "find all instances of profile X" queries
for concurrency checks.

## 7. Registration Flow

### 7.1 With Profile (singleton)

```
messaging_register("os-pm")
  1. profileRepo.getProfile("os-pm")
     → { name: "os-pm", maxInstances: 1, persona: "...", ... }

  2. Query: SELECT * FROM agents WHERE base_name = "os-pm"
     → check each for isProcessAlive(pid)
     → 0 live instances

  3. maxInstances = 1, 0 live → OK
     registeredName = "os-pm" (singleton, no suffix)

  4. UPSERT agent row:
     id = "os-pm", base_name = "os-pm", persona = "...",
     objective = "...", pid = process.pid, registered_at = now

  5. autoJoinChannels: subscribe to each channel that exists
     → record successes and failures

  6. Return:
     {
       registeredName: "os-pm",
       baseName: "os-pm",
       instanceNumber: null,
       profile: { persona, objective, maxInstances },
       autoJoined: { succeeded: [...], failed: [...] }
     }
```

### 7.2 With Profile (pool)

```
messaging_register("os-dev")
  1. profileRepo.getProfile("os-dev")
     → { name: "os-dev", maxInstances: 3, ... }

  2. Query: SELECT * FROM agents WHERE base_name = "os-dev"
     → os-dev-1 (pid 1234, alive), os-dev-2 (pid 5678, dead)

  3. Reclaim lowest dead slot: slot 2
     registeredName = "os-dev-2"

  4. UPSERT agent row:
     id = "os-dev-2", base_name = "os-dev", persona = "...",
     objective = "...", pid = process.pid, registered_at = now

  5–6. Same as singleton (autoJoin, return)

  Return includes: registeredName = "os-dev-2", instanceNumber = 2
```

### 7.3 Pool at Capacity

```
messaging_register("os-dev")
  1. Profile lookup → maxInstances: 3
  2. Query → os-dev-1 (alive), os-dev-2 (alive), os-dev-3 (alive)
  3. All 3 slots occupied by live processes
  → Error: "Profile 'os-dev' is at maximum capacity (3/3 instances).
     Active instances: os-dev-1 (pid 1234), os-dev-2 (pid 5678),
     os-dev-3 (pid 9012)"
```

### 7.4 Without Profile

```
messaging_register("random-agent")
  1. profileRepo.getProfile("random-agent") → null
  2. Fall through to current behavior:
     agents.register("random-agent", process.pid)
  3. Return:
     {
       registeredName: "random-agent",
       baseName: null,
       instanceNumber: null,
       profile: null,
       autoJoined: null,
     }
```

Fully backward compatible. No profile = current behavior.

**Suffixed namespace reservation (Decision #14):** Names matching
`{profile_base_name}-\d+` are reserved when a profile exists. Resolution order:
1. Exact profile match → use that profile (handles edge case of a profile named `os-dev-2`)
2. No exact profile, but name matches `{profile_base_name}-\d+` for an existing profile →
   reject with: "Name 'os-dev-2' is reserved by pool profile 'os-dev'. Register as 'os-dev'
   to join the pool."
3. No match → allow without profile (current behavior)

This prevents silent overwrites where a rogue unprofiled `os-dev-2` would collide
with a profiled pool's slot assignment.

### 7.5 Race Condition Handling

The entire profile check + slot assignment + agent upsert happens inside a single
SQLite `EXCLUSIVE` transaction. If two processes race for the same slot:

1. Process A acquires the write lock, claims slot 1, commits
2. Process B retries (`withRetrySync`), re-reads live instances, sees slot 1 taken
3. Process B claims slot 2 (or is rejected if at capacity)

This is the same concurrency pattern used throughout the codebase. No new locking.

## 8. Pool-Wide @Mentions

### 8.1 Behavior

When a message contains `@os-dev` (a base name matching a profile):

- **Stored mentions:** The raw mention `os-dev` is stored in the `mentions` column
  as-is. This preserves semantic intent ("I wanted to reach the dev pool").
- **Notification targets:** At dispatch time, `os-dev` is expanded to all live
  instances (`os-dev-1`, `os-dev-2`, etc.) for notification delivery.
- **Targeted mentions still work:** `@os-dev-2` targets only that specific instance.
  No expansion.

### 8.2 Implementation

`extractMentions()` in `core/utils.ts` currently validates mentions against a list
of known agent IDs. The change:

1. Continue extracting `@name` tokens from content
2. For each token, check if it matches a known `agent.id` (current behavior)
3. **NEW:** If no direct match, check if it matches a base name from
   `ProfileRepository.getBaseNames()`. If so, include the base name as a mention.
   This ensures pool mentions are recognized even before any instance has registered.
4. At dispatch time, `resolveTargets()` in `MessagingService` expands base-name
   mentions to individual live instances (via `agents.findByBaseName()`)

The function signature gains an optional parameter:
`extractMentions(content, validAgentIds, profileBaseNames?: Set<string>)`
When `profileBaseNames` is not provided, behavior is identical to current (no
base-name expansion). The caller (`MessagingService.send()`) passes the set from
`ProfileRepository.getBaseNames()` when profiles are configured.

### 8.3 Mention Storage

The `mentions` column stores the raw mentions as extracted (including base names):

```json
["os-dev"]        // pool mention — expanded at dispatch time
["os-dev-2"]      // instance mention — no expansion needed
["os-dev", "bob"] // mixed — os-dev expands, bob is direct
["*"]             // broadcast — unchanged
```

This means historical queries ("find messages mentioning os-dev") work correctly
regardless of which instances were alive when the message was sent.

### 8.4 Edge Case: Zero Alive Instances

If `@os-dev` is used and no `os-dev-*` instances are alive:

- Message is stored normally (SQLite persistence invariant)
- Mention `os-dev` is stored in the `mentions` column
- Notification dispatch expands to zero targets → no notifications sent
- When an `os-dev` instance later registers and auto-joins, it sees the message
  on its next `read_messages` call

No "pending mention" queue. The channel is already the durable record.

## 9. API Changes

### 9.1 `messaging_register`

**Input:** Unchanged — `agent_id: string`. The caller passes the base name
(`os-dev`), and the server resolves the registered name (`os-dev-2`).

**Output:** Extended (additive, not breaking).

```typescript
interface RegisterResult {
  // Always present (existing fields preserved)
  id: string;            // = registeredName
  created_at: number;
  last_seen_at: number;
  pid: number;
  registered_at: number;

  // New fields (null for agents without a profile)
  registeredName: string;      // canonical identity for this session
  baseName: string | null;     // profile base name, null if no profile
  instanceNumber: number | null; // pool slot number, null for singletons / no profile
  profile: {
    persona: string | null;
    objective: string | null;
    maxInstances: number;
  } | null;
  autoJoined: {
    succeeded: string[];
    failed: Array<{ channel: string; reason: string }>;
  } | null;
  // domainsClaimed: deferred from v1 — see section 10.2
}
```

**MCP tool description update:** The tool description must prominently state:
"The `registeredName` in the response is your agent's canonical identity for this
session. Always use it for subsequent calls (`send_message`, `subscribe`, etc.)."

### 9.2 `messaging_list_agents`

**Output:** Extended — each agent in the list gains optional fields.

```typescript
interface AgentListEntry {
  // Existing fields
  id: string;
  created_at: number;
  last_seen_at: number;
  pid: number | null;
  registered_at: number | null;

  // New fields
  base_name: string | null;
  persona: string | null;
  objective: string | null;
}
```

No new input parameters. No search/filter API in v1.

## 10. autoJoinChannels and brainDomains

### 10.1 autoJoinChannels

Executed during registration, after the agent row is inserted/updated:

1. For each channel name in `autoJoinChannels`:
   a. Look up the channel by name
   b. If found: subscribe the agent (using `registeredName`, not base name)
   c. If not found: record failure with reason `"channel not found"`
2. Failures are not fatal — registration succeeds, failures are reported in
   the response

**Why not create-on-demand:** Channel creation has ownership implications
(`created_by`). Auto-creating introduces ambiguity about who owns the channel
and what happens when a profile is removed. Explicit creation is cleaner.

### 10.2 brainDomains (deferred from v1)

**Cut from v1** `BrainService.claimDomain()` only claims the repo's
configured domain — arbitrary profile domains would require a new BrainService API.
Deferred to Phase 4 (Brain Evolution). The profile schema uses warn-and-ignore for
unknown fields, so `brainDomains` in YAML is accepted but not acted upon in v1.

## 11. Hex Arch Placement

### 11.1 Core (`src/core/`)

**Extension to `core/messaging/types.ts`**

The `Agent` type gains three optional fields:

```typescript
export interface Agent {
  id: string;
  created_at: number;
  last_seen_at: number;
  pid: number | null;
  registered_at: number | null;
  // New — populated from profile at registration time
  base_name: string | null;
  persona: string | null;
  objective: string | null;
}
```

**New file: `core/profiles/types.ts`**

```typescript
export interface AgentProfile {
  name: string;          // base name
  persona: string | null;
  objective: string | null;
  maxInstances: number;  // >= 1
  autoJoinChannels: string[];
  // brainDomains: deferred from v1 — see section 10.2
}
```

**Addition to `core/ports.ts`**

```typescript
export interface ProfileRepository {
  getProfile(baseName: string): AgentProfile | null;
  listProfiles(): AgentProfile[];
  getBaseNames(): Set<string>;
}
```

`getBaseNames()` returns the set of all profile base names for use in
`extractMentions()` — the mention parser needs to know which names are
pool base names for expansion.

**Changes to `MessagingService`**

- Constructor gains `profiles?: ProfileRepository` parameter (optional — backward compat)
- `register()` gains profile-aware logic (section 7)
- `resolveTargets()` gains base-name mention expansion (section 8)
- `extractMentions()` gains base-name awareness (called with profile base names)

### 11.2 Storage: YAML Adapter (`src/storage/yaml-profiles/`)

**New file: `storage/yaml-profiles/store.ts`**

Implements `ProfileRepository`. Loads YAML files from a configured directory
on construction. Returns `null` for unknown base names.

- Uses a YAML parser (e.g., `js-yaml` or Bun's built-in)
- Validates schema on load (throws on invalid profiles)
- Caches parsed profiles in memory (profiles are read-only config)
- No SQLite dependency — pure filesystem read

### 11.3 Storage: SQLite Changes (`src/storage/sqlite/`)

**`agent-repo.ts` changes:**

- `register()` gains optional `profileFields: { baseName, persona, objective }`
  parameter for writing profile data to the agent row
- New query: `findByBaseName(baseName: string): Agent[]` for concurrency checks
- `listAll()` return type extended to include `base_name`, `persona`, `objective`

**Migration:** New migration `messaging_003_agent_profiles` (section 6.1)

### 11.4 Composition Root (`src/main.ts`)

Wiring additions:

1. Read `OCTO_SANTA_PROFILES_DIR` (default `~/.octo-santa/profiles/`)
2. If directory exists: create `YamlProfileStore`, pass to `MessagingService`
3. If not: pass `undefined` — no profiles, current behavior

### 11.5 Boundary Rules

- Core imports `AgentProfile` type and `ProfileRepository` port — no YAML, no filesystem
- YAML adapter imports from `core/profiles/types.ts` and `core/ports.ts` — no SQLite
- SQLite adapter has no knowledge of profiles beyond the extra columns
- `MessagingService` orchestrates: reads profile via port, checks concurrency
  via agent repo, writes result to agent repo

## 12. Migration and Backward Compatibility

### 12.1 Schema Migration

The `messaging_003_agent_profiles` migration adds three nullable columns to the
`agents` table. This is non-destructive:

- Existing agent rows get `base_name = NULL`, `persona = NULL`, `objective = NULL`
- All existing queries continue to work (new columns are not in WHERE clauses
  of existing queries)
- The `idx_agents_base_name` index is created for the new concurrency check query

### 12.2 Behavioral Compatibility

- Agents without profiles: identical behavior to current. `messaging_register("x")`
  → agent row with `base_name = NULL`.
- `messaging_list_agents`: returns the three new fields as `null` for legacy agents.
  Callers that don't read these fields are unaffected.
- `messaging_register` return: existing fields unchanged. New fields are additions.
  JSON-parsing callers that ignore unknown fields are unaffected.
- `extractMentions`: if no `ProfileRepository` is injected, behavior is identical
  to current (no base-name expansion).
- Existing MCP tool names, parameter names, and required parameters: unchanged.

### 12.3 No Breaking Changes

This feature is purely additive. No existing tool, API, or database contract changes
in a way that breaks current behavior. Principle 5 (backward compatibility is
non-negotiable) is preserved.

## 13. Future Work

Items explicitly excluded from v1, with trigger conditions for revisiting:

| Item | Trigger | Notes |
|------|---------|-------|
| `requireProfiles: true` strict mode | Demand from deployments wanting to lock down agent registration | Global config flag in `.octo-santa/config.json` |
| Runtime profile reload + enforcement | Phase 2 CLI ships (`ocs profiles reload --enforce`) | Registration-time-only is correct for v1 |
| Per-profile skill assignment | Feature 3 ADR resolves "where does enforcement live" | Plugin ecosystem concern, not core |
| Per-profile sandboxing | Feature 3 ADR + Claude Code plugin integration | Adapter concern — core defines identity, adapters enforce boundaries |
| Profile search/filter API | `messaging_find_agent(capability: "...")` demand | v1: callers scan `messaging_list_agents` themselves |
| Per-org/team profile sets | Real multi-team deployment pain (Feature 1 trigger) | Thin layer on top of profiles: "which profile set applies to this database" |
| Profile-aware heartbeat | Future consideration if pool behavior needs dynamic rebalancing | Currently heartbeat is identity-agnostic |
| `messaging_list_profiles` tool | Debugging difficulty during profile development | Useful for inspecting loaded profiles. Phase 2 CLI scope. |

### 13.1 Plugin Integration Path

When octo-santa ships as a Claude Code plugin, profiles have a natural migration
path:

- Profile YAML maps to the plugin's `agents/` directory with frontmatter
  (`model`, `maxTurns`, `disallowedTools`)
- Plugin hooks (`PreToolUse`, `SubagentStart`) can enforce profile constraints
  at the Claude Code level
- Plugin sandboxing adds filesystem/network isolation per agent
- Core profiles remain the identity layer; plugin components add enforcement

This migration does not require changes to the profile schema or core logic —
it's an additional adapter layer. The identity question (Feature 2, this spec)
is independent of the enforcement question (Feature 3, separate ADR).
