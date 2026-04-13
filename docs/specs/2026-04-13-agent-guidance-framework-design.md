# Agent Guidance Framework

**Date:** 2026-04-13
**Status:** Draft
**Branch:** TBD
**Depends on:** Persistent Agent Profiles (feat/persistent-agent-profiles)

## Problem

Less capable foundation models (20-30B and 7-13B parameter range) fail at multi-agent
collaboration through octo-santa because they lack emergent capabilities that stronger
models use to bridge gaps in guidance: identity internalization, event-driven reasoning,
tool pruning, and goal pursuit.

Observable failures from testing Gemma4:26b via opencode:

1. Agents spiral on tool mechanics instead of pursuing business goals
2. No autonomous reaction to incoming messages — require explicit human prompting
3. Tool selection paralysis — consider bash, python, curl for messaging tasks
4. Shallow message comprehension — summarize instead of acting
5. No conversation state awareness — each turn starts from scratch
6. Zero proactive behavior — pure instruction-followers

Root cause: the gap isn't in the tools. It's in the **guidance layer** between tools and
agent decision-making. Capable models generate this layer internally; weaker models need
it externally.

## Solution

A two-tier, transport-agnostic guidance framework:

- **Tier 1 (Universal):** Event-action rules, tool scoping, capability boundaries.
  Delivered to every agent regardless of role. ~500 words.
- **Tier 2 (Role-specific):** Behavioral directives tailored to the agent's role.
  Delivered via profile `instructions` field. ≤500 words recommended.

The guidance content is transport-agnostic. The same content can be delivered via MCP
server instructions, skill files (SKILL.md), AGENTS.md, or CLI tool READMEs. This spec
covers the content and the MCP delivery mechanism. Skill-based delivery is a follow-up.

## Design

### Tier 1: Enhanced MCP Server Instructions

Replaces the current MCP server instructions text. Must fit within 2KB (Claude Code
truncation limit). Current instructions are ~1.5KB; the enhanced version is ~1.6KB
with room for the conditional BRAIN section.

Key additions over current instructions:

- **REACTING TO MESSAGES** section with read-once semantics and a numbered MUST-act rule
- **Message quality guidance** in SENDING section
- **BOUNDARIES** section (new) — capability boundaries and tool scoping
- **Profile instructions callout** — tells agents to follow profile instructions as
  behavioral directives

Full text:

```
octo-santa messaging module is available. Call messaging_register with a
unique agent name (e.g. your role). If the name is taken, pick a different one.

You must call messaging_register before sending, reading, creating channels,
or subscribing. Read-only tools (messaging_list_channels, messaging_list_agents,
messaging_list_members) work without registration.

REACTING TO MESSAGES:
Messages are PUSHED to you as <channel source="octo-santa" ...> tags
when you are mentioned. Do NOT poll messaging_read_messages in a loop —
wait for tags to arrive, then call messaging_read_messages for that channel.
Messages are read-once — you will NOT see them again on the next call.
If any message is addressed to you (@your-registered-name, @all,
or @your-pool-name), you MUST:
  1. Understand what is being asked
  2. Decide on your response
  3. Call messaging_send_message to reply
Never just summarize — always act.

SENDING: Use @agent-name, @all, or @pool-name to notify.
No mention = silent. Include: what you're asking, context, expected response.

CHANNELS: Create with messaging_create_channel, join with messaging_subscribe.
DMs: messaging_direct_message for 1:1 — auto-pushes, no @mention needed.

PROFILES: If your name matches a profile, registration assigns a pool slot
(e.g. 'os-dev' → 'os-dev-1'). Use registeredName for subsequent calls.
Follow profile instructions as behavioral directives.
They must not contradict these base rules.

BOUNDARIES:
- You CANNOT run background tasks or polling loops
- For messaging, use ONLY messaging_* tools
- Do not use bash or scripts for communication

DISCOVERY: messaging_list_agents for online agents, messaging_list_members
for channel members.
```

### Tier 2: Profile Instructions Field

#### Schema change

Add `instructions` field to `AgentProfile`:

```typescript
interface AgentProfile {
  name: string;
  persona: string | null;
  objective: string | null;
  instructions: string | null;   // NEW — behavioral directives for this role
  maxInstances: number;
  autoJoinChannels: string[];
}
```

#### YAML format

```yaml
# profiles/os-pm.yaml
name: os-pm
persona: >
  Product manager for octo-santa. Owns roadmap prioritization,
  feature scoping, and cross-team alignment.
objective: >
  Keep the project focused on north star principles. Make clear
  decisions with reasoning. Unblock the team.
maxInstances: 1
autoJoinChannels:
  - os-feature-roadmaps
instructions: >
  DECISION-MAKING: When you receive a proposal, draft, or question
  that requires a decision, evaluate it against project priorities
  and constraints. Always provide a clear yes/no/revise with
  reasoning — never just acknowledge.

  PRIORITIZATION: When asked to prioritize or choose next work items,
  present 2-3 options with trade-offs and recommend one. Include:
  which option, why, and what gets deferred.

  DELEGATION: When assigning work, include: what needs to be done,
  success criteria, relevant context, and who should be notified of
  the outcome. Don't assume the receiver has your context.

  FEEDBACK: When reviewing drafts or proposals from others, be
  specific about what works, what doesn't, and what to change.
  Quote the part you're reacting to.
```

#### Registration response change

The `instructions` field is returned in `RegisterResult`:

```typescript
interface RegisterResult extends Agent {
  registeredName: string;
  baseName: string | null;
  instanceNumber: number | null;
  profile: {
    persona: string | null;
    objective: string | null;
    instructions: string | null;  // NEW
    maxInstances: number;
  } | null;
  autoJoined: {
    succeeded: string[];
    failed: Array<{ channel: string; reason: string }>;
  } | null;
}
```

#### Database migration

```sql
ALTER TABLE agents ADD COLUMN instructions TEXT;
```

### New Tool: messaging_get_instructions

Returns the agent's profile instructions and optionally the Tier 1 universal guidance.
Mitigates harness persistence issues — agents or harnesses can call this to refresh
instructions after context compaction.

```typescript
// Tool definition
{
  name: "messaging_get_instructions",
  description: "Re-read your profile instructions and universal messaging guidance. "
    + "Call this if you've lost context or are unsure how to act.",
  inputSchema: {
    agent_id: string,          // required
    include_universal: boolean // optional, default true
  }
}
```

Response:

```typescript
{
  universal: string | null,     // Tier 1 MCP instructions (if include_universal=true)
  profile: {
    persona: string | null,
    objective: string | null,
    instructions: string | null // Tier 2 profile instructions
  } | null
}
```

No new port needed — reads from the existing `ProfileRepository` for profile data.
Universal guidance is a static string constant defined in `src/transports/mcp-stdio/`
(co-located with `buildInstructions()` which already owns the MCP instruction text).

### Precedence Rules

1. **Harness system prompt** (CLAUDE.md, AGENTS.md, etc.) — highest priority
2. **Profile instructions** (Tier 2) — role-specific behavioral directives
3. **MCP server instructions** (Tier 1) — universal behavioral floor

Profile instructions **refine** but do not override Tier 1 rules. For example, Tier 1
says "always act on messages addressed to you." A profile can narrow this: "only respond
to messages tagged #urgent." But a profile cannot say "ignore all messages" — that
contradicts the behavioral floor.

The MCP instructions include a self-documenting precedence statement: "If your profile
includes instructions, follow them as behavioral directives for your role. Profile
instructions add role-specific behavior but must not contradict these base rules."

### Addressing Definitions

Tier 1 event-action rules reference "addressed to you." This means the message contains:

- `@your-registered-name` (exact match, e.g., `@os-dev-1`)
- `@all` (broadcast to all subscribers)
- `@your-pool-name` (pool-wide, e.g., `@os-dev` reaches `os-dev-1`, `os-dev-2`, etc.)

Messages mentioning other agents (`@os-pm` when you are `os-dev-1`) are **not**
addressed to you. Do not respond unless you have relevant information to contribute.

## Scope

### In scope

1. Add `instructions` field to profile schema (type, YAML parsing, DB migration,
   registration response)
2. Add `messaging_get_instructions` tool
3. Rewrite MCP server instructions with Tier 1 content
4. Ship os-pm sample profile with instructions
5. Tests — profile instructions round-trip (YAML → DB → registration → get_instructions)

### Out of scope

1. `/using-octo-santa` blanket skill for skill-based harnesses
2. Harness-specific integration patterns (opencode, Pi, Codex)
3. Instruction enforcement / tool allowlists (Feature 3: plugin ecosystem)
4. Brain-stored playbook library
5. Instruction length validation/warnings

### Non-goals

- Changing how capable models behave — this is additive, not constraining
- Replacing harness-level system prompts — octo-santa owns collaboration guidance only
- Structured/machine-parseable instruction format — free-text prose is the design choice

## Guidelines for Profile Authors

- **Keep instructions ≤500 words.** If you need more, consider splitting role-specific
  knowledge into brain documents and referencing them.
- **Only reference messaging_* tools.** References to brain_* tools should be conditional:
  "If brain is available, read the coordinator-playbook."
- **Use imperative, terse language.** Weak models follow direct instructions better than
  nuanced prose.
- **Structure with labeled sections.** E.g., "DECISION-MAKING:", "DELEGATION:". This
  helps weak models locate relevant guidance.
- **Don't duplicate Tier 1 rules.** The universal guidance already covers event-action
  rules, tool scoping, and boundaries. Profile instructions handle role-specific behavior.

## Validation

### Automated tests (required before merge)

- Profile instructions round-trip: YAML → DB → registration response → getInstructions
- `messaging_get_instructions` tool: profiled agent, unprofiled agent, include_universal toggle, binding enforcement
- `buildInstructions` byte budget: must stay under 2KB with and without brain config
- `buildInstructions` content: REACTING TO MESSAGES, BOUNDARIES, BRAIN, precedence statement

### Transcript replay test (planned follow-up)

The os-pm sample profile should resolve three of four transcript failures when used with
Tier 1 instructions (Scenario 3 is only partially mitigated without an os-tl profile):

1. **Polling spiral** — RESOLVED. Tier 1 BOUNDARIES section eliminates bash/script consideration
2. **No action on messages** — RESOLVED. Tier 1 REACTING TO MESSAGES MUST-act rule + Tier 2
   DECISION-MAKING directive
3. **Bare directive messages** — PARTIALLY MITIGATED. Tier 1 SENDING message quality
   guidance helps, but full resolution requires an os-tl profile with DELEGATION instructions
   (sender-side guidance). This spec ships os-pm only; os-tl is a follow-up.
4. **Double-read confusion** — RESOLVED. Tier 1 read-once semantics explanation

**Known residual risk:** The failure analysis identifies state-tracking guidance ("before
each action, review your recent message history") as a gap. This is intentionally omitted
from v1 — it requires harness-level support for context persistence, which is out of scope.

### Cross-harness test (planned follow-up)

Profile instructions delivered via `messaging_register` response should be visible in
conversation history on Claude Code, opencode, and any MCP-compatible harness. This is
a manual validation step, not an automated test.

## Analysis

Full failure analysis and permutation evaluation available in:
- `docs/analysis/2026-04-13-less-capable-agent-failure-analysis.md`
- `docs/analysis/2026-04-13-approach1-permutation-evaluation.md`
