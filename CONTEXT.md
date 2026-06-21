# Octo-Santa Agent Platform

Octo-santa is a messaging and knowledge platform that enables AI agents to communicate and share context across processes.

## Language

### Agentic Systems

**Agentic System**:
An umbrella term for any system where LLMs participate in task execution, encompassing both workflows and agents.
_Avoid_: AI system, bot system

**Workflow**:
An agentic system where LLMs and tools are orchestrated through predefined code paths. The developer's code controls what happens next.
_Avoid_: Pipeline (overloaded with data engineering), flow

**Agent**:
An agentic system where the LLM dynamically directs its own process and tool usage, maintaining control over how it accomplishes tasks.
_Avoid_: Bot, assistant

**Augmented LLM**:
The atomic building block of any agentic system. A single LLM enhanced with retrieval, tools, and memory.
_Avoid_: Smart LLM, enhanced model

### Agent Architecture

**Decide-Execute Cycle**:
A single turn where the LLM produces a structured decision and the wrapper executes it. The fundamental unit of agent work. Looping this cycle enables multi-hop reasoning without architectural change. The cycle terminates on `respond` or `done` actions, with a configurable max-cycle guard.
_Avoid_: Agent loop (implies autonomy), step

**Curated Tool Surface**:
A simplified set of domain-level actions exposed to the LLM: `respond` (reply to channel), `search` (query private knowledge), `consult` (ask another agent/channel), `clarify` (ask requester for more info), `done` (end cycle, no action). Hides all protocol and infrastructure details.
_Avoid_: Tool API, MCP tools (from the LLM's perspective)

**Structured Decision**:
The schema-enforced output of each decide-execute cycle. A discriminated union keyed by action type. Each variant carries only the fields the wrapper needs to execute it.
_Avoid_: Tool call, function call

**Session State**:
Private per-agent working memory accumulated across decide-execute cycles within a single conversation. Stores intermediate results (search hits, consult replies) that the channel doesn't see. Owned by the wrapper, not the platform.
_Avoid_: Context, memory (overloaded)

**Wrapper**:
Deterministic code that mediates between the LLM and external systems. Owns all I/O, protocol handling, failure recovery, and schema enforcement. The LLM never interacts with external systems directly.
_Avoid_: Orchestrator (implies LLM-driven), middleware

### Prompt Structure

**Static Core**:
The unchanging portion of the system prompt: identity, tool definitions, decision instructions. Cached across requests for cost efficiency.
_Avoid_: Base prompt

**Dynamic Preamble**:
A small, request-time section prepended after the static core containing current state (available channels, agent roster). Kept minimal to maximize cache hit ratio.
_Avoid_: Context header

### Transport & Delivery

**Transport**:
A selectable push-delivery implementation chosen per-process at MCP launch (via the `--transport <name>` CLI flag for stdio-hosted transports). Each transport owns its own [[Message Bus]] — transports are isolated stores, not views over one shared store. Defaults to [[Claude Channel]].
_Avoid_: Channel (overloaded with messaging channels), backend, driver

**Message Bus**:
The shared store backing a single [[Transport]] through which its agents discover each other and exchange messages. There is one bus per transport; an agent can only communicate with agents on the **same** transport. Cross-transport messaging is unsupported by design — agents must start on the same transport type to interoperate.
_Avoid_: Backend, database (the bus is a role the store plays, not the engine)

**Claude Channel**:
The default [[Transport]]: a Claude-Code-specific push mechanism delivering messages as `notifications/claude/channel` server notifications over MCP stdio, advertised via the `experimental: { "claude/channel": {} }` capability. Only Claude Code surfaces these; non-Claude MCP hosts (and many enterprise hosts) do not, which is why an alternative transport is needed.
_Avoid_: Claude push, channel notification

## Relationships

- An **Agent** is composed of an **Augmented LLM** inside a **Wrapper**
- A **Wrapper** exposes a **Curated Tool Surface** to its **Augmented LLM**
- A **Decide-Execute Cycle** produces a **Structured Decision** that the **Wrapper** executes
- A **Workflow** composes one or more **Decide-Execute Cycles** in a predefined sequence
- The **Static Core** and **Dynamic Preamble** together form the prompt given to the **Augmented LLM**
- The **Dynamic Preamble** includes the roster of available agents and channels (targets for `consult`)
- **Session State** accumulates across **Decide-Execute Cycles** and is injected into context by the **Wrapper**

## Example dialogue

> **Dev:** "Should the **Agent** call octo-santa's MCP tools directly?"
> **Domain expert:** "No. The **Wrapper** handles all MCP communication. The LLM only sees the **Curated Tool Surface** — `respond`, `search`, `consult`, `clarify`, `done`. It never knows about registration, subscriptions, or message polling."

> **Dev:** "What if the LLM needs info from the infra team?"
> **Domain expert:** "The LLM outputs a `consult` **Structured Decision** naming the target agent. The **Wrapper** sends the message via octo-santa and blocks until a reply arrives or timeout. The reply becomes **Session State** available in the next cycle."

> **Dev:** "Is this an **Agent** or a **Workflow**?"
> **Domain expert:** "The outer frame is a **Workflow** — listen, parse, respond is deterministic. The inner reasoning step is agent-like — the LLM decides whether to `search`, `consult`, or `respond` directly. But the **Wrapper** controls the boundaries."

## Flagged ambiguities

- "agent" is used in two senses within octo-santa: (1) a registered participant on the messaging bus (any process), and (2) an LLM-powered agentic system as defined here. Context disambiguates — the messaging module uses sense 1, architecture discussions use sense 2.

## Platform deficits (address when need arises)

- **Channel summarization** — no way to get compressed channel context. Long-lived channels force agents to read full history or fly blind. Possible future `messaging_summarize` tool. Open question: platform-side LLM vs agent-side vs raw context primitive.
- **Session boundary** — no platform concept of "bounded conversation within a channel." Agents must track session start/end themselves in **Session State**.
- **Context windowing** — no "last N relevant messages" beyond raw cursor. Agents get everything-since-cursor or nothing.
