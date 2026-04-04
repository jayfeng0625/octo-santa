# Brain Module — Exploration Notes

## Implementation Approaches

Three options for scoping the spec. All share the same design decisions
captured in this document — the difference is what ships together.

### Approach A: Brain Module Only (pure addition)

Ship the brain module in isolation. No messaging changes.

**Scope:**
- 6 brain tools: `brain_index`, `brain_read`, `brain_shared_index`,
  `brain_shared_read`, `brain_find_expert`, `brain_claim_domain`
- 2 tables: `domains`, `domain_claims`
- `.octo-santa/config.json` reading + domain auto-registration
- `OctoModule.onDisconnect` lifecycle hook
- `instructions` field extended with brain context
- Bootstrap notification extended with brain nudge
- Path sandboxing for `brain.dirs`

**Does NOT include:**
- `messaging_direct_message` (new tool)
- `messaging_read_messages` access control fix
- `messaging_rename_channel` (new tool)
- Agent table active/stale filtering

**Trade-offs:**
- (+) Smallest blast radius, brain testable in isolation
- (+) No risk of breaking existing messaging behavior
- (-) `brain_find_expert` returns data but agent can't act on it
  deterministically — no `messaging_direct_message` to DM the expert
- (-) The cross-domain query flow doesn't work end-to-end
- (-) SLC violation: not "complete" — brain is lovable but the story
  ends at discovery with no reliable way to reach the expert

### Approach B: Brain + Messaging DM Support (cross-domain ready) ← RECOMMENDED

Ship brain module + the minimum messaging additions for the cross-domain
query flow to work end-to-end.

**Scope:**
Everything in A, plus:
- `messaging_direct_message` (new tool — create DM channel, subscribe
  both, send message)
- `messaging_read_messages` access control fix (require existing cursor)

**Does NOT include:**
- `messaging_rename_channel` (new tool)
- Agent table active/stale filtering
- Messaging single-purpose audit remediation

**Trade-offs:**
- (+) Cross-domain query flow works end-to-end: discover → DM → answer
- (+) The "complete" in SLC — brain discovery leads to action
- (+) Read access fix prevents DM mode breakage (functional bug)
- (-) Touches messaging module — needs careful testing of existing behavior
- (-) Slightly larger scope than A

### Approach C: Brain + Full Messaging Improvements

Ship brain module + all identified messaging improvements.

**Scope:**
Everything in B, plus:
- `messaging_rename_channel` (new tool, members only)
- `messaging_list_agents` active/stale filtering (Phase 1 from audit)
- Agent table pollution visibility fix

**Trade-offs:**
- (+) Most complete — addresses the agent pollution pain point too
- (+) All gap analysis items resolved in one pass
- (-) Largest scope, most risk
- (-) Messaging audit Phase 1 is independently valuable — could be its
  own spec without blocking brain
- (-) Scope creep risk — "while we're in there" additions

### Recommendation: Approach B

B is the SLC choice. Brain without DM support is incomplete — discovery
that can't lead to action violates the "complete" principle. But the
messaging audit and rename tool are independently valuable improvements
that don't need to ship with brain. They get their own spec.

The read access fix is bundled because it's a functional bug that
`messaging_direct_message` would expose — creating DM channels that any
agent can break by reading them is not acceptable.

---

## The Vision
Moving from monorepo → multiple focused micro-repos. Each repo owns a domain,
each has agents that start up with octo-santa. The brain module gives agents
domain expertise; messaging lets other agents query that expertise.

The monorepo ceiling: too much information without RAG. The alternative:
focused agents that collaborate, each deep in their domain.

## Core Architecture: Agent-as-Expert

Agents ARE the query interface to domain knowledge. You don't search another
domain's brain — you DM the agent that owns it.

```
Cross-domain query flow:

  Agent A (repo A)                          Agent B (repo B)
  ─────────────────                         ─────────────────
  1. brain_find_expert("payments")
     → { identifier: "payments-api",
         active_session: "be-impl", ... }
  2. messaging_direct_message("fe-impl",
       "be-impl", "@be-impl how do
       webhooks retry?")
                                            3. Gets push notification (DM mode)
                                            4. brain_index() → sees webhook-schemas doc
                                            5. brain_read("webhook-schemas")
                                            6. Replies with answer in DM
  7. Gets answer, continues work
```

No cross-domain brain access. No RAG. The LLM IS the query engine.

## Decisions Made

### SLC: offline expert → do nothing
Expert offline? Requesting agent is told "not available." Human starts it.
No fallback, no degraded mode.

### Brain is its own OctoModule
Separate from messaging. Own migrations (100-199), own tools, own tables.
References agent_id but doesn't touch messaging schema.

### Index-based approach, even for small brains
No eager loading. Agent gets frontmatter index on demand, reads full docs
only when relevant. Maximum efficiency without over-engineering.

### Frontmatter-derived index, MEMORY.md style
Each brain doc has frontmatter (title, summary, tags). `brain_index()` scans
the directory and assembles the index at read time. Can never drift.

The output format follows the proven MEMORY.md pattern — one line per doc,
slug + summary, enough to decide "should I read this?":

```
brain_index() returns:
- [./brain/webhook-schemas.md](webhook-schemas) — Payload formats for all outbound webhooks including retry behavior, signature verification, and event type taxonomy
- [./brain/billing-cycles.md](billing-cycles) — Monthly/annual billing state machine, proration rules, grace periods
- [./brain/refund-policy.md](refund-policy) — Refund eligibility windows, partial refund calculations, chargeback handling
```

Each brain doc carries the frontmatter that drives this:

```yaml
---
title: Webhook Schemas
summary: Payload formats for all outbound webhooks including retry behavior,
  signature verification, and event type taxonomy
tags: [webhooks, events, api-contracts]
---
```

The index is the same information density as a hand-curated MEMORY.md, but
assembled automatically from doc frontmatter — zero drift, zero maintenance.

### Implicit domain registration via .octo-santa/config.json
No explicit registration tool. Config declares domain identity, brain module
reads it on startup (process.cwd()), auto-registers domain metadata in SQLite.
Domain is immediately discoverable via `brain_find_expert`. Agent session
identity (messaging) is separate — see deep dive #2.

### Cross-domain queries via DM, not domain channels
brain_find_expert() returns domain info + active session names. Requesting
agent DMs them via `messaging_direct_message`. DM mode = push notifications
for all messages. No routing confusion about where to reply. Domain channels
dropped — unnecessary complexity.

## Per-Domain Config: .octo-santa/config.json

> **Superseded:** earlier drafts used `agent.name`/`agent.domains`. Deep dive
> #2 established that config describes the repo's domain, not an agent.
> See "Config Shape: Domain, Not Agent" in the deep dive section below.

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

The repo's declaration of its place in the octo-santa network.
Brain module reads this from process.cwd() when MCP server starts.
`domain.identifier` names the domain (brain registry), NOT the messaging agent.

## Startup Sequence

```
1. Agent starts Claude Code session in repo
2. octo-santa MCP server spawns (stdio), inherits CWD
3. Brain module reads .octo-santa/config.json from CWD (if present)
4. Brain module auto-registers domain metadata in SQLite
5. Bootstrap notification: domain identity + brain index + messaging tools
6. Agent calls messaging_register (session identity, separate from domain)
7. Agent calls brain_claim_domain (opt-in, links session to domain)
8. Agent can call brain_index() to see its domain knowledge
9. Other agents discover via brain_find_expert("payments")
10. Cross-domain queries happen via messaging_direct_message
```

Steps 6-7 are explicit tool calls driven by skills, not implicit behavior.

## Tool Surface (Brain Module)

### Domain brain (local to agent)
| Tool | Purpose |
|------|---------|
| `brain_index` | Scan domain brain dirs, return frontmatter index |
| `brain_read` | Read full content of a brain doc by slug |

### Shared brain (global, ~/.octo-santa/brain/)
| Tool | Purpose |
|------|---------|
| `brain_shared_index` | Frontmatter index of shared brain docs |
| `brain_shared_read` | Read a specific shared brain doc |

### Knowledge network (discovery + claiming)
| Tool | Purpose |
|------|---------|
| `brain_find_expert` | Query domain registry: who covers this topic? Returns domain info + active session names |
| `brain_claim_domain` | Link this agent's session name to the repo's domain registration. Requires prior `messaging_register`. |

Domain registration is config-driven (auto on startup). Domain claiming
is agent-driven (explicit tool call). Unclaiming is implicit (server
lifecycle cleanup on session close).

## What Goes Where

| Layer | Content | Accessed by |
|-------|---------|-------------|
| Domain brain (in repo) | API docs, schemas, domain decisions, local architecture | Owning agent only |
| Shared brain (~/.octo-santa/brain/) | Cross-domain contracts, org conventions, deployment patterns | All agents |
| Domain registry (SQLite) | Domain tags, description → agent mapping | All agents (discovery) |

## Deep Dives Needed

### 1. Bootstrap Integration
How does brain_index get into the agent's awareness on startup? The messaging
module currently pushes a channel notification prompting messaging_register.
Should the brain module do something similar — push a notification containing
the domain index so the agent is primed from the start?

Questions to resolve:
- Push on connect (automatic) vs. explicit tool call (agent-driven)?
- If pushed, what format? Full index in the notification, or just a nudge
  to call brain_index()?
- How does this compose with the existing messaging bootstrap prompt?
- Should there be a single unified startup sequence across modules?

### 2. Config as Single Source of Agent Identity
If .octo-santa/config.json declares agent.name, should messaging_register
also read from it? This would make the config the single source of identity —
not just brain metadata but the agent's name, role, everything.

Questions to resolve:
- Does messaging_register become implicit too (read name from config)?
- If so, does messaging_register still exist as a tool, or does the agent
  just "exist" on startup with no registration calls at all?
- What happens if config.json has agent.name but the agent calls
  messaging_register with a different name? Error? Override?
- Scope: should config.json eventually own ALL per-domain octo-santa config,
  making it the single touchpoint for "how does this repo participate in
  the network"?

### 3. Repackage octo-santa as a Claude Code Plugin

Claude Code has a plugin system. Research validated against official docs
(code.claude.com/docs/en/plugins.md, plugins-reference.md, plugin-marketplaces.md).

#### Validated Plugin Capabilities

**Plugin structure:**
```
octo-santa-plugin/
├── .claude-plugin/
│   └── plugin.json          # manifest: name, version, description, userConfig, channels
├── skills/                  # auto-invoked by Claude based on context
│   └── brain-index/
│       └── SKILL.md
├── agents/                  # subagent definitions
│   └── domain-expert.md
├── hooks/
│   └── hooks.json           # event handlers (SessionStart, PostToolUse, etc.)
├── .mcp.json                # bundled MCP server — starts automatically when plugin enabled
├── settings.json            # default settings (only "agent" key currently supported)
└── scripts/
```

**SessionStart hook (confirmed):**
- Fires when a session begins or resumes
- Can run shell commands, HTTP requests, or LLM prompts
- Has access to `${CLAUDE_PLUGIN_ROOT}` (plugin install dir) and `${CLAUDE_PLUGIN_DATA}` (persistent state dir)
- This is the mechanism for bootstrap — read config, register domain, prime agent

**Channels (confirmed):**
- Declared in plugin.json `channels` array
- Each channel binds to an MCP server key in the plugin's `.mcp.json`
- Supports per-channel `userConfig` (e.g., bot tokens)
- This is the first-class replacement for `--dangerously-load-development-channels`

**Skills (confirmed):**
- `skills/` directory with `name/SKILL.md` structure
- Frontmatter: name, description (used for auto-invocation matching)
- Claude auto-invokes based on task context — no explicit tool call needed
- Can include supporting files alongside SKILL.md
- Namespaced: `/octo-santa:brain-index`

**Agents (confirmed):**
- `agents/` directory with markdown files
- Frontmatter: name, description, model, effort, maxTurns, tools, disallowedTools, isolation
- Claude can invoke automatically or user invokes manually
- Cannot declare hooks, mcpServers, or permissionMode (security restriction)

**userConfig (confirmed):**
- Declared in plugin.json, prompted at enable time
- Available as `${user_config.KEY}` in MCP/LSP configs, hook commands
- Also exported as `CLAUDE_PLUGIN_OPTION_<KEY>` env vars
- Sensitive values go to system keychain
- Non-sensitive stored in settings.json under `pluginConfigs[<plugin-id>].options`

**MCP servers in plugins (confirmed):**
- `.mcp.json` at plugin root, standard MCP config format
- Start automatically when plugin is enabled
- Use `${CLAUDE_PLUGIN_ROOT}` for paths to bundled server code
- Tools appear as standard MCP tools in Claude's toolkit

**Path variables (confirmed):**
- `${CLAUDE_PLUGIN_ROOT}`: absolute path to plugin install dir. Changes on update.
- `${CLAUDE_PLUGIN_DATA}`: persistent dir for state that survives updates (~/.claude/plugins/data/{id}/)
- Both substituted in skill content, agent content, hook commands, MCP/LSP configs
- Both exported as env vars to subprocesses

**Plugin scopes (confirmed):**
- `user`: ~/.claude/settings.json — personal, all projects (default)
- `project`: .claude/settings.json — shared via version control
- `local`: .claude/settings.local.json — project-specific, gitignored
- `managed`: read-only, admin-controlled

**Marketplace distribution (confirmed):**
- Any git repo with `.claude-plugin/marketplace.json`
- Plugin sources: relative path, GitHub, git URL, git-subdir, npm
- Install: `/plugin marketplace add owner/repo` then `/plugin install plugin@marketplace`
- Official submission: claude.ai/settings/plugins/submit
- Team distribution: `extraKnownMarketplaces` in .claude/settings.json
- Auto-updates via git pull on startup (needs auth tokens for private repos)

#### Answers from Superpowers Plugin Analysis

Explored the live superpowers plugin (v5.0.7) at /Users/Home/Development/oss/superpowers.

**SessionStart hook stdout → conversation context (CONFIRMED):**
The hook outputs JSON with `additionalContext` field, which Claude Code injects
as conversation context. The superpowers bootstrap works by reading its
`using-superpowers/SKILL.md` and outputting it wrapped in `<EXTREMELY_IMPORTANT>`
tags. Claude sees this as instructions.

The exact stdout contract for Claude Code:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "<string to inject into conversation>"
  }
}
```

This is the brain priming mechanism. A SessionStart hook can read
.octo-santa/config.json and brain doc frontmatter, then inject the brain index
as conversation context. The agent is primed from the start without any MCP
tool call.

**Convention over configuration (CONFIRMED):**
Superpowers plugin.json is minimal — just metadata (name, version, description,
author). No component paths declared. Claude Code auto-discovers skills/,
agents/, commands/, hooks/hooks.json at the plugin root by convention.

**Skills are purely prompt-based (CONFIRMED):**
Superpowers has zero MCP servers. Skills reference Claude Code's built-in tools
(Read, Write, Bash, Grep, Skill, Task) by name in markdown. Skills don't call
MCP tools — they tell Claude which tools to use via instructions.

This means brain_index/brain_read as SKILLS would work by instructing Claude to
call the MCP tools: "Call the brain_index MCP tool to see your domain knowledge."
Skills = instructions that can reference any tool Claude has access to.

**No channels, no userConfig, no settings.json in superpowers:**
Superpowers is purely skills + 1 agent + 1 SessionStart hook. Channel and
userConfig features exist in the plugin system but superpowers doesn't use them.
These remain validated from docs only.

#### CWD Discovery — RESOLVED

Evidence from fakechat plugin and all channel plugins in claude-plugins-official:

```json
// fakechat .mcp.json
{
  "mcpServers": {
    "fakechat": {
      "command": "bun",
      "args": ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--shell=bun", "--silent", "start"]
    }
  }
}
```

Fakechat EXPLICITLY sets `--cwd ${CLAUDE_PLUGIN_ROOT}` because bun needs to
find package.json there to run `bun install && bun server.ts`. This is a bun
runtime requirement, not a Claude Code requirement.

The implication: without `--cwd`, child processes inherit the parent's CWD.
Claude Code's CWD IS the user's project directory. So by default, a plugin MCP
server gets the user's project CWD — which is exactly what octo-santa needs.

**The pattern for octo-santa's .mcp.json:**
```json
{
  "mcpServers": {
    "octo-santa": {
      "command": "bun",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/mcp.js"]
    }
  }
}
```

Use `${CLAUDE_PLUGIN_ROOT}` for the path to the bundled server code, but do NOT
set `--cwd`. This way:
- `process.cwd()` = user's project directory (can read .octo-santa/config.json)
- Server code loaded from plugin cache via absolute path
- Existing CWD-based config discovery works unchanged

**EMPIRICALLY VERIFIED (2026-03-31):**

Test plugin at `test-cwd-plugin/` with `.mcp.json` using
`"args": ["${CLAUDE_PLUGIN_ROOT}/server.ts"]` (no --cwd override).

Launched from `/tmp/cc-plugin-test`:
```
cwd:         /private/tmp/cc-plugin-test   ← user's project directory ✓
plugin_root: /Users/Home/Development/octo-santa/test-cwd-plugin
plugin_data: /Users/Home/.claude/plugins/data/test-cwd-inline
```

Confirmed: `process.cwd()` = wherever Claude Code was launched. Plugin MCP
servers inherit the user's project CWD. The `.octo-santa/config.json` discovery
pattern works unchanged when packaged as a plugin.

#### Channel Mechanism — RESOLVED

Research from channels-reference.md, fakechat source, and GitHits confirms:

**plugin.json does NOT declare channels.** Channel capability is declared
entirely in the MCP server code via the handshake:

```ts
const mcp = new Server(
  { name: 'octo-santa', version: '...' },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {} }
    },
    instructions: '...'
  }
)
```

**octo-santa already implements channels correctly.** The existing code in
src/mcp.ts declares `experimental: { "claude/channel": {} }` and src/channel.ts
sends `notifications/claude/channel` with content + meta. This IS the plugin
channel mechanism — same protocol, same format.

**What Claude sees when a channel notification arrives:**
```xml
<channel source="octo-santa" channel_name="general" sender="agent-b">
  agent-b: @payments-api how do webhooks retry?
</channel>
```

**Proactive notifications confirmed:** mcp.notification() can be called at any
time — from polling loops, HTTP handlers, WebSocket callbacks. Not limited to
tool call responses. octo-santa's polling loop in channel.ts is already this
pattern.

**The `channels` field in plugin.json** (from the docs) is optional — it's for
declaring per-channel userConfig (e.g., bot tokens). For octo-santa, the MCP
server handles channel creation internally. No plugin.json channels declaration
needed.

**Key detail: fakechat uses low-level `Server`, not `McpServer`.** Fakechat
imports from `@modelcontextprotocol/sdk/server/index.js`. octo-santa uses
`McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`. Both work — McpServer
is a higher-level wrapper. The notification method is available on both.

**Zero code changes needed** for the channel system when packaging as a plugin.

#### Remaining Resolved Questions

**Plugin config vs .octo-santa/config.json**: Two config systems coexist cleanly.
`userConfig` in plugin.json handles global settings (shared brain dir) — prompted
at plugin enable time, available as env vars. `.octo-santa/config.json` in each
repo handles per-domain config (agent name, domains, brain dirs). No conflict.

**Brain tools: hybrid MCP tools + skill instructions**: brain_find_expert,
brain_index, brain_read remain MCP tools (they query SQLite). A plugin skill
can instruct Claude when/how to call them. The skill is the "when" (auto-invoked
by context), the MCP tool is the "how" (explicit DB query). Same pattern as
superpowers skills referencing Claude's built-in tools.

**Bootstrap composition**: SessionStart hook injects brain index as conversation
context. MCP server pushes messaging bootstrap notification via channel. Two
independent paths that compose naturally. No unified startup sequence needed.

**Migration path**: Plugin .mcp.json replaces user's manual .mcp.json entry.
User does `/plugin install octo-santa@marketplace`, removes their manual entry.
MCP server code is identical — just bundled differently. The `--dangerously-load-
development-channels` flag is needed during research preview; approved plugins
use `--channels plugin:octo-santa@marketplace`.

## Resolved Open Threads

### Shared brain location
Convention default (`~/.octo-santa/brain/`), with configurable override — same
pattern as the messaging DB (`OCTO_SANTA_DB` env or `~/.octo-santa/messages.db`).
When plugin is packaged, `userConfig` can set the override at enable time.

### Shared brain write access
Both human and agents can write. (REPL approach is being overhauled separately —
ignore REPL-related concerns for now.)

### Multi-agent-per-repo routing
"Pick any" for SLC. `brain_find_expert` returns all matching agents — caller
picks. Later refinements: active/inactive status, busy/available. The key is
ensuring DM functionality works cleanly so the caller can reach any expert.

### Bootstrap content
Path of least resistance: extend the existing MCP server bootstrap notification.
The MCP server already sends a channel notification on connect
("octo-santa messaging module is available..."). The brain module reads
`.octo-santa/config.json` on startup for domain registration — it already has
the config parsed. Extend the bootstrap notification to include brain context:
domain identity, brain index (scanned from frontmatter), and available tools.

No SessionStart hook needed. No bash YAML parsing. Just extend the existing
bootstrap message in mcp.ts. One notification primes both messaging and brain.

### Brain tools: all MCP tools, no skills
Path of least resistance: all five brain tools (`brain_index`, `brain_read`,
`brain_shared_index`, `brain_shared_read`, `brain_find_expert`) are MCP tools.
No plugin skill wrappers. The bootstrap notification tells Claude the tools
exist and when to use them — same pattern as messaging.

Adding skill wrappers would mean writing SKILL.md files, managing skill-to-tool
indirection, and shipping extra files. For SLC, MCP tools only. Can add skills
later if auto-invocation proves valuable.

### Config as identity + persistent agent — DEEP DIVE #2

#### The Pain Point

Agent table pollution. Every session spawns an ad-hoc name (`backend-1`,
`be-3`, `fe-1-tests`), the row persists forever, `messaging_list_agents`
becomes a graveyard. The question: can `.octo-santa/config.json` solve this
by providing stable identity?

#### Real Use Cases (all must be supported)

- 2 agents in 1 repo, ad-hoc names, no config
- Multiple agents across repos with config (domain experts)
- 1 coordinator + N workers in separate setups
- Second session in same repo needs a different name than config declares
- Developer experimenting, wants to override config name

Conclusion: config is opt-in. Ad-hoc naming is a first-class use case.

#### Agent Table Cleanup

The pollution problem is about **visibility, not restriction**. Agent rows
should persist for message history attribution, but discovery tools
(`list_agents`, `brain_find_expert`) should default to showing only relevant
agents — not 30 dead sessions.

Decision: add a clear "active vs gone" distinction. Discovery defaults to
active/config-declared agents. Stale rows exist for history but are hidden
from the working view.

#### Key Insight: Brain Identity ≠ Messaging Identity

Three proposals were evaluated for config-as-identity:

**A. Auto-register on startup** — config exists → `registerAgent` runs
internally → session bound before any tool call.
- Breaks multi-session-same-repo (PID conflict on second session)
- Breaks role flexibility (coordinator forced into domain expert name)
- Rejected.

**B. Pre-fill but don't bind** — config read → bootstrap suggests name →
agent explicitly calls `messaging_register`.
- Flexible but creates brain-to-messaging identity mismatch
- `brain_find_expert` returns config name, but agent registered under
  a different messaging name → DM goes nowhere
- Config becomes advisory, doesn't solve naming discipline
- Rejected.

**C. Auto-register with override** — auto-register → allow rebinding if
agent calls `messaging_register` with different name.
- Session rebinding doesn't exist today (`onAgentId` throws on mismatch)
- Same PID conflict as A on second session
- Adds complexity without solving the core problem
- Rejected.

**The underlying tension**: all three conflate two distinct concepts:

1. **Domain identity** (brain) — "this repo covers payments." Stable,
   declared in config, one per repo. Used by `brain_find_expert`.
2. **Session identity** (messaging) — "who am I in this conversation."
   Ephemeral, per-session, might vary by role or task.

These must be **separate**. Config declares domain identity for the brain
module. `messaging_register` handles session identity independently. They
CAN be the same name but don't have to be.

#### No Implicit Linkage — Explicit Tool Calls Only

The brain module registers domains from config on startup (auto-populated
in SQLite). Messaging registration is a separate explicit tool call. There
is NO automatic linkage between the two.

If an agent wants to be discoverable as the active expert for a domain, it
explicitly calls a tool to link its session name to the domain registration.
Otherwise the domain exists in the registry but has no active agent attached.

No side effects, no sequencing concerns, no magic. Tools are available
independently. The agent decides what to use and when.

#### Config Shape: Domain, Not Agent

The config describes the **repo's place in the network**, not an agent.
The `agent` key was renamed to `domain` to reflect this — avoids confusion
between domain identity (brain) and session identity (messaging).

```json
{
  "domain": {
    "label": "payments-api",
    "tags": ["payments", "billing", "subscriptions"],
    "description": "Payment processing, webhook delivery, billing cycles"
  },
  "brain": {
    "dirs": ["./brain"]
  }
}
```

`brain_find_expert("payments")` returns:
```json
{
  "identifier": "payments-api",
  "tags": ["payments", "billing", "subscriptions"],
  "description": "Payment processing, webhook delivery, billing cycles"
}
```

Bootstrap notification: "This repo's domain is payments-api, covering
payments/billing/subscriptions."

`domain.identifier` = domain registry identifier (brain).
`messaging_register(agent_id)` = session name (messaging). Fully separate.

#### Explicit Domain Claiming via brain_claim_domain

`brain_claim_domain(agent_id)` — the agent explicitly links its messaging
session name to this repo's domain registration. After claiming:

```
brain_find_expert("payments")
→ { label: "payments-api", ..., active_session: "payments-api-reviewer" }
```

The caller gets an exact messaging name to DM. Deterministic routing, no
prompt-dependent inference.

Without claiming, `brain_find_expert` returns domain info but no active
session — the domain exists but nobody is manning it.

Multiple experts per domain is a valid state — two agents in the same
backend repo can both claim. The caller decides how to handle multiple
results (DM one, DM all) — that's a skill-level decision.

#### Asymmetric Lifecycle: Explicit Claim, Implicit Unclaim

- **Claiming is explicit** — agent calls `brain_claim_domain` after
  `messaging_register`. Opt-in. A coordinator in a backend repo registers
  for messaging but doesn't claim — not discoverable as domain expert.
- **Unclaiming is implicit** — `unregisterAgent` (called by mcp.ts
  onclose) also unclaims across the brain database. Cleanup. The process
  is dying, no skill can run, stale claims would make `brain_find_expert`
  return dead session names.

This means: `brain_unclaim_domain` does NOT need to exist as an MCP tool.
Unclaim is server lifecycle, not an agent action.

Skills teach the composition: "If you're in a repo with config and your
role is domain expert, call brain_claim_domain after messaging_register."

#### Design Principle: Tools Are Atoms, Skills Are Molecules

MCP tools must be single-purpose with no side effects. Each tool does
exactly one thing. How to compose tools into workflows is the job of
skills (markdown instructions) and code — not baked into tool side effects.

The one exception: server lifecycle cleanup (onclose) can coordinate
across databases. This is internal plumbing, not a tool-level concern.

#### New Messaging Tools Identified

**messaging_direct_message(agent_id, target_agent_id, content)**
Creates a DM channel between two agents (sorted deterministic name like
`agent-a,agent-b`), subscribes both, sends the message. Both agents get
push notifications. One atomic tool for "start a conversation with someone."

**messaging_rename_channel(agent_id, channel, new_name)**
Rename a channel and notify all members. Useful when a DM evolves into a
group conversation — invite more agents, rename to something meaningful.

**No invite tool.** Agents join channels by choice. To get agent-x into
a channel, DM them: "@agent-x join channel project-planning." Agents
have agency.

## Stretch Goal: SessionStart Hook for Brain Priming

The MCP bootstrap notification is the SLC path, but a SessionStart hook would
be strictly better for priming: it fires earlier (before MCP handshake), and
the context lands as `additionalContext` alongside system context.

**What the hook does:**

1. Check if `.octo-santa/config.json` exists at CWD
2. If yes: read it, extract agent name + domains + description
3. Scan brain doc directories from `brain.dirs` config
4. For each `.md` file: extract YAML frontmatter (title, summary, tags)
5. Assemble the brain index (one line per doc, MEMORY.md style)
6. Output JSON:
   ```json
   {
     "hookSpecificOutput": {
       "hookEventName": "SessionStart",
       "additionalContext": "You are payments-api, a domain expert in payments, billing, subscriptions.\n\nYour brain contains:\n- [webhook-schemas](webhook-schemas) — Payload formats for all outbound webhooks...\n- [billing-cycles](billing-cycles) — Monthly/annual billing state machine...\n\nUse brain_index and brain_read tools to consult your domain knowledge."
     }
   }
   ```

**Implementation:** A bash script at `hooks/session-start` (same pattern as
superpowers). YAML frontmatter parsing is just extracting lines between `---`
delimiters — `awk` can handle it:

```bash
# Extract title and summary from frontmatter
awk '/^---$/{n++; next} n==1{print}' "$doc" | while read line; do
  case "$line" in
    title:*) title="${line#title: }" ;;
    summary:*) summary="${line#summary: }" ;;
  esac
done
```

**Why stretch, not SLC:** The MCP bootstrap notification already works and
requires no new files. The hook adds a bash script that parses YAML, escapes
JSON, and handles edge cases (no config, empty brain dirs, malformed frontmatter).
It's more robust priming but more surface area. Layer it on after the core
module works.

## Gap Analysis (2026-04-03)

Comprehensive review of exploration decisions against codebase. Organized
by priority: must-resolve → should-resolve → deferred.

### Must Resolve Before Spec

#### 1. Brain claim table needs PID for crash-recovery unclaim — RESOLVED

The claim table links `agent_id` to `domain.label`. `unregisterAgent`
clears by PID match. Claim table includes PID column — unclaim query:
`DELETE FROM claims WHERE agent_id = ? AND pid = ?`. Same ownership-scoped
pattern as messaging. `(agent_id, pid)` is the composite key for all
ownership operations.

Brain and messaging share the same DB file (separate tables, not separate
databases). Brain writes are cold path (startup, claim, unclaim) — no
practical contention with messaging's hot path (send, cursor, heartbeat).
WAL + withRetrySync handles the rare overlap. Same DB also keeps the
architecture simple: one openDb(), one migration sequence.

#### 2. OctoModule needs a lifecycle hook for disconnect cleanup — RESOLVED

Add `onDisconnect(db, agentId, pid)` to the `OctoModule` interface. Each
module implements its own cleanup. `mcp.ts` loops through modules on close,
same as it loops through `registerTools` on startup.

```ts
export interface OctoModule {
  name: string;
  migrations: Migration[];
  registerTools: (...) => void;
  onDisconnect?: (db: Database, agentId: string, pid: number) => void;
}
```

`mcp.ts` onclose: `for (const mod of modules) mod.onDisconnect?.(db, boundAgentId, process.pid)`

**Future note:** cleanup order may matter if modules have dependencies
(e.g., brain unclaim before messaging unregister). For SLC, order is
undefined — modules clean up independently. Add an explicit ordering
mechanism later if needed.

#### 3. Domain registry + claims table schema — RESOLVED

```sql
-- Domain registry (auto-populated from config on startup)
CREATE TABLE domains (
  identifier TEXT PRIMARY KEY,   -- globally unique, network-wide identifier
  cwd TEXT NOT NULL,            -- repo path that owns this domain
  tags TEXT NOT NULL,           -- JSON array, e.g. '["payments","billing"]'
  description TEXT NOT NULL,
  registered_at INTEGER NOT NULL
);

-- Domain claims (explicit via brain_claim_domain)
CREATE TABLE domain_claims (
  agent_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  domain_identifier TEXT NOT NULL REFERENCES domains(identifier),
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, pid)
);
```

Key decisions:
- `identifier` is globally unique (PK). Duplicate identifiers across repos
  are a config mistake — force the human to fix it (use `payments-legacy`,
  `payments-v2`). Identifier is a network-wide handle.
- Startup upserts by identifier. If CWD changes (repo moved), the row updates.
- Claims PK is `(agent_id, pid)` — one claim per session. FK to domains
  ensures you can only claim an existing domain.
- Unclaim: `DELETE FROM domain_claims WHERE agent_id = ? AND pid = ?`

#### 4. No-config behavior — RESOLVED

`.octo-santa/config.json` is a brain module concern only. Messaging is
fully independent — no config needed, works exactly as today.

When config is missing:
- Brain module skips domain registration silently (no error on startup)
- `brain_index` / `brain_read` → return empty (no brain dirs configured)
- `brain_claim_domain` → error ("no domain configured for this repo")
- `brain_find_expert` → works (queries global domain registry)
- `brain_shared_index` / `brain_shared_read` → works (reads ~/.octo-santa/brain/)

An agent in a repo without config can still discover and query other
domains. It just can't be a domain expert itself.

#### 5. brain_find_expert search semantics — RESOLVED

Return all domains with their active claims. Let the LLM filter and pick.
Domain count will be small (tens, not thousands) — the LLM is already
the query engine, no need to build matching logic.

The tool is effectively `brain_list_domains` — returns all registered
domains with identifier, tags, description, and any active session names.
No search parameter needed. Simple, predictable, no matching logic to
get wrong.

### Should Resolve Before Spec

#### 6. brain_claim_domain requires prior messaging_register — RESOLVED

`brain_claim_domain` validates that the agent has an active registration
(PID set in agents table) before allowing the claim. Throws if not
registered. This is a precondition, not a side effect.

When `brain_find_expert` returns domains with no active sessions, the LLM
knows no expert is available and can prompt the user to start an agent in
that repo.

#### 7. Bootstrap compaction risk — RESOLVED

Use `instructions` field on McpServer for domain identity + brain tool
descriptions (survives context compaction). Use the channel notification
for the actionable nudge ("register, then claim").

This extends the existing `instructions` string in `mcp.ts` — brain module
contributes its section alongside messaging's existing instructions.
Domain identity persists across compaction. The notification is a one-time
prompt to action.

### Deferred to Post-SLC

#### 8. DM channel read access — MUST FIX

`messaging_direct_message` creates channels with deterministic names
(e.g., `agent-a,agent-b`). Without access control, any agent can read a
DM channel by constructing the name. Worse: `messaging_read_messages`
creates a cursor (via `ensureAgent`), making the reader a member. Member
count goes 2→3, flipping the channel from DM mode (push all) to group
mode (mention-only). One unsolicited read breaks notification semantics
for both original participants.

**Fix:** `messaging_read_messages` requires an existing cursor in the
channel. No cursor = no read. Agents join channels by being subscribed
(via `messaging_direct_message`, `messaging_create_channel`, or
`messaging_send_message`), not by reading.

Note: this is a messaging module fix, not a brain module concern. Should
be addressed alongside `messaging_direct_message` implementation.

#### 9. Path sandboxing for brain.dirs

Config declares `"brain": { "dirs": ["./brain"] }`. No validation prevents
`"dirs": ["../../.."]` from exposing files outside the repo. In a plugin
context, the MCP server runs with user permissions.

**Deferred.** For SLC, define constraint: brain dirs must be relative and
within CWD. Reject absolute paths and `..` traversal. Implement validation
in the spec but full sandboxing is post-SLC.

#### 10. Shared brain write tool missing — DEFERRED

No `brain_shared_write` for SLC. Not clear what the use case would be.
Agents can use the built-in `Write` tool for file system access if needed.
Revisit if a concrete need emerges.

#### 11. brain_read slug-to-filepath mapping — DEFERRED

`brain_read("webhook-schemas")` maps to `<dir>/<slug>.md`. Markdown only.
Subfolders, README, index files, and other structures are valid — nothing
novel to a well-trained LLM. Define details in spec.

#### 12. messaging_rename_channel access control — RESOLVED

Only channel members can rename. Membership check required (agent must
have a cursor in the channel).

#### 13. messaging_direct_message auto-subscribes target

The tool subscribes both parties without the target's consent. This is
by design for DMs (both parties should get notifications), but is a side
effect on the target agent.

**Accepted by design.** Document clearly that DMs auto-subscribe both
parties. This is the expected UX for direct messaging.

#### 14. brain_find_expert with no active_session — RESOLVED

Already addressed by #6. When no expert is claimed, the LLM sees no
`active_session` in the results and prompts the user to start an agent
in that repo. The tool description teaches the distinction between
domain identifier and messaging agent_id.

### Existing Messaging Tool Audit

A separate remediation report has been written at
`docs/specs/remediation/messaging-tools-single-purpose-audit.md`. It flags
implicit side effects in `messaging_send_message`, `messaging_read_messages`,
`messaging_create_channel`, and the `ensureAgent` internal function. These
are existing debt — not blockers for the brain module, but should be
addressed after brain lands and skill-driven composition is mature.
