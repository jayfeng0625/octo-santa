---
title: Architecture
summary: Hexagonal architecture overview — ports, adapters, cross-cutting concerns, bootstrap flow
tags: [architecture, hexagonal, ports-and-adapters]
---

# Architecture

octo-santa uses hexagonal architecture (ports and adapters). The core domain defines
interfaces; adapters implement them. Storage, transport, and notification concerns are
independently swappable.

## North Star

octo-santa is a local-first agent collaboration framework. Agents on the same
machine discover each other, communicate through channels, and share domain
knowledge — without servers, accounts, or network access. A single SQLite file
(`messages.db`) is the entire backend.

Full north star and strategic roadmap live in the
[octo-santa-roadmaps](../octo-santa-roadmaps) repo. This section captures what
you need to make correct design decisions in this codebase.

### Principles

1. **Local-first, always.** Zero network, zero cloud, zero accounts. Network
   features are additive layers — never requirements.
2. **Simple, lovable, complete.** Ship narrow but polished. Each capability works
   end to end. No "coming soon" placeholders.
3. **Interfaces over implementations.** Core defines ports for its own needs.
   Adapters conform to ports. Ports must not be shaped by adapter capabilities.
4. **One job per component.** If you can't describe it in one sentence without
   "and", it's doing too much.
5. **Backward compatibility is non-negotiable.** Existing tools, notifications,
   lifecycle, database — all unchanged by internal refactors.
6. **Correctness over cleverness.** Explicit, boring code over clever indirection.

### Deployment Model

These are physical facts about how octo-santa runs. Every design must account
for them.

- **Each agent is its own OS process.** Claude Code spawns octo-santa as an MCP
  subprocess. Two agents = two processes. No shared memory.
- **SQLite is the only shared state.** There is no IPC, no named pipe, no message
  queue. Cross-process communication = read/write to the shared database.
- **Cross-process delivery requires polling (or a future IPC bridge).** Event-driven
  dispatch works in-process only. Anything that needs to reach another process must
  go through SQLite. Accept this constraint; don't design around it.
- **`notifications/claude/channel` only works over stdio.** Claude's push mechanism
  is non-standard and transport-specific. Non-Claude clients and HTTP transports
  cannot use it.
- **Core dispatches push statelessly; adapters own delivery reliability.** Current
  push is best-effort (N-process model, 2s poller). As transports mature (MCP 2.0
  session resumability, message queues), adapter-level push reliability improves
  without core changes. Pull (`read_messages`, future `messaging_listen`) is always
  available as fallback. Messages are never lost — SQLite persistence is the invariant.

### Decision Checklist

Before any design involving notification, delivery, or cross-agent communication:

1. Does it work when sender and receiver are in **different processes**?
2. Does it work when there are **N processes** sharing one SQLite file?
3. Does it introduce ports shaped by **adapter needs** rather than core needs?
4. Does it add infrastructure requirements (servers, accounts, running services)?
5. Does it break existing behavior for current users?

If the answer to 1 or 2 is "no", the design is incomplete. If the answer to
3, 4, or 5 is "yes", find another way.

## Directory Layout

```
src/
  core/                          ← Domain logic. No infrastructure imports.
    messaging/
      service.ts                 ← MessagingService — orchestrates messaging operations
      types.ts                   ← Agent, Channel, Message, etc.
    brain/
      service.ts                 ← BrainService — orchestrates brain/domain operations
      types.ts                   ← BrainDoc, Domain, DomainExpert, etc.
    ports.ts                     ← All port interfaces (repositories, notification, brain store)
    utils.ts                     ← Pure domain utilities (validation, mention parsing, liveness)

  contracts/                     ← Thin-core product seam (PubSub + PeerDiscovery).
    index.ts                     ← PURE TYPES. Zero runtime deps, zero infra imports, no core.

  adapters/                      ← Seam adapters (implement src/contracts). No cross-adapter deps.
    in-memory/
      in-memory-pubsub.ts        ← InMemoryPubSub reference adapter (ephemeral, in-process)

  storage/                       ← Storage adapters
    sqlite/                      ← SQLite implementation of all repository ports
      agent-repo.ts
      channel-repo.ts
      message-repo.ts
      cursor-repo.ts
      domain-repo.ts
      notification-query-repo.ts ← Internal class for cross-process poller queries
      index.ts                   ← Factory: createSqliteRepos(db)
      db.ts                      ← createDb(), withRetrySync()
      migrations.ts              ← Schema migrations
    fs-brain-store/
      store.ts                   ← Filesystem BrainStore (markdown scanning)

  transports/                    ← Transport adapters (how external clients connect)
    mcp-stdio/
      adapter.ts                 ← MCP tool registration, agent binding, main()
      helpers.ts                 ← jsonResult(), withAgent()
    repl/                        ← Terminal UI for human participation
      app.ts, commands.ts, etc.

  notifications/                 ← Notification adapters (how agents receive push)
    dispatch/
      dispatcher.ts              ← In-process event-driven dispatch (fires on send())
    poller/
      poller.ts                  ← Cross-process SQLite poller (2s interval)
    ports.ts                     ← Placeholder for future notification adapter ports

  main.ts                        ← Composition root — wires everything together
  log.ts                         ← Logging utility
```

## Core Domain

The core (`src/core/`) contains pure business logic. It has zero infrastructure imports —
no `bun:sqlite`, no `@modelcontextprotocol`, no transport-specific code.

### Port Interfaces (`core/ports.ts`)

The core defines interfaces that adapters implement:

| Port | Purpose |
|------|---------|
| `AgentRepository` | Agent CRUD, registration, heartbeat, liveness |
| `ChannelRepository` | Channel CRUD, membership, rename with announcement |
| `MessageRepository` | Message insert, cursor-advancing reads, history reads |
| `CursorRepository` | Read cursor tracking per agent per channel |
| `DomainRepository` | Brain domain registration and claiming |
| `BrainStore` | Markdown document scanning and reading |
| `NotificationPort` | Push delivery contract (transport-agnostic) |
| `NotificationDispatch` | Event-driven dispatch — core calls on `send()` |

Core is push-first. `NotificationDispatch` is the sole notification interface
in core — it says "push this to these agents." How delivery happens (in-process
dispatch, cross-process polling, future MCP 2.0 push) is an adapter concern.
No polling interfaces live in core.

### Services

Two services orchestrate business logic through port interfaces:

**`MessagingService`** — registration, channels, messaging, DMs, mentions, cursor
management. On `send()`, resolves mention targets and invokes `NotificationDispatch`
for in-process event-driven push.

**`BrainService`** — brain document indexing/reading, domain registration/claiming,
expert discovery.

Services are process-scoped singletons. They hold `process.pid` for agent ownership
checks.

### Domain Utilities (`core/utils.ts`)

Pure functions with no dependencies: `validateAgentName()`, `isDmChannel()`,
`extractMentions()`, `isAgentActive()`, `isProcessAlive()`.

## How the Layers Connect

### Send path (event-driven dispatch)

```
  Transport          Core Service          Storage          Dispatcher
  (MCP stdio)        (MessagingService)    (SQLite repos)   (in-process)
      │                     │                    │               │
      │  send("hi @bob")    │                    │               │
      ├────────────────────►│                    │               │
      │                     │  messageRepo       │               │
      │                     │  .insertAndJoin()  │               │
      │                     ├───────────────────►│               │
      │                     │◄───────────────────┤               │
      │                     │                    │               │
      │                     │  dispatch(targets) │               │
      │                     ├──────────────────────────────────►│
      │                     │                    │               │── handlers.get("bob")
      │                     │                    │               │   → undefined (different
      │                     │                    │               │     process) → skip
      │◄────────────────────┤                    │               │
      │  return Message     │                    │               │
```

### Cross-process delivery (poller)

```
  Poller              Storage
  (in Bob's process)  (shared SQLite)
      │                    │
      │  [every 2s]        │
      │  getNewMessages    │
      │  ForAgent("bob",   │
      │    hwm, 100)       │
      ├───────────────────►│
      │◄───────────────────┤
      │  messages since    │
      │  last HWM          │
      │                    │
      │── mention filter   │
      │── port.notify()    │
      │── advance HWM      │
```

The service writes to storage and dispatches in-process. Cross-process delivery
happens independently via the poller reading shared SQLite — the database is the
cross-process message bus.

## Cross-Cutting Concerns

### 1. Notification Delivery

Two coexisting mechanisms deliver push notifications:

**In-process dispatcher** (`src/notifications/dispatch/`): `MessagingService.send()`
resolves mention targets and calls `NotificationDispatch.dispatch()` synchronously.
The adapter looks up handlers in an in-memory `Map<string, NotificationPort>`.
Originally retained for a future multi-agent-per-process transport (Phase 3b direct
mode). **Currently dead code and scheduled for removal** — see
`docs/specs/2026-05-16-notification-dispatch-consolidation-prd.md`. Modern coding
harnesses provide subagents at the harness layer (each as its own process), so a
multi-agent-per-process MCP transport is no longer on the roadmap.

**Cross-process poller** (`src/notifications/poller/`): Each process runs a 2-second
`setInterval` that queries SQLite via raw functions injected from the composition root.
Uses an adapter-owned high-water mark (HWM) completely independent of the read cursor.
Mention filtering happens at the adapter level using the pre-extracted `mentions` column.
**This is the mechanism that actually delivers notifications today, and will be the
sole push mechanism after the dispatcher is removed.**

### 2. Agent Liveness

The MCP transport adapter runs a heartbeat timer that calls
`agentRepo.heartbeatOrReclaim()` every 10 seconds. This updates `last_seen_at` in
storage. The service uses `isAgentActive()` to filter agents in `listAgents()`,
`listMembers()`, and `findExperts()`. Liveness is transport-independent.

### 3. Agent Registration and Disconnect

The service handles `register()` and `unregister()` as pure storage operations.
Transport adapters manage session lifecycle — MCP stdio calls register on first
tool call and unregister on close. A future HTTP adapter might use session timeouts.
The service doesn't know the trigger.

### 4. DM Channel Creation

Service creates the DM channel, subscribes both agents, and sends the message —
all storage writes. Each party's process picks up the new message from SQLite via
its poller.

### 5. Brain Domain Discovery

Service handles `claimDomain()` (write) and `findExperts()` (read + liveness
filter). Transport adapters just expose the tools.

### 6. Cursor Tracking

Service manages read cursors via repos. `readForwardAndAdvance()` atomically reads
and advances the cursor. The notification poller maintains its own high-water mark
(HWM) in memory — completely independent of the read cursor. This independence is
critical: bugs #7 and #8 (fixed in v0.7.0) were caused by the old architecture
sharing cursor state between the read path and the notification path.

**The pattern:** service writes to storage. Cross-process delivery goes through
SQLite (the poller). No adapter-to-adapter communication. The database is the
cross-process message bus.

## Bootstrap Flow

The composition root (`src/main.ts`) wires everything top-down:

1. **Storage** — create DB, run migrations, create all repos + notification query class
2. **Brain store** — read config, create filesystem store
3. **Notification dispatcher** — create in-process dispatcher
4. **Core services** — inject repos and dispatcher into `MessagingService`
5. **Domain registration** — register domain metadata if configured
6. **Transport adapter** — register MCP tools, set up agent binding with:
   - `registerNotificationHandler` / `unregisterNotificationHandler` (dispatcher)
   - `startPoller` factory (creates and starts cross-process poller on agent bind)
   - Heartbeat timer (10s interval)
7. **Connect** — start stdio transport, set up disconnect handler

The poller starts lazily — only when an agent registers and binds. On disconnect,
the poller is stopped and the agent's handler is unregistered from the dispatcher.

## Adding New Adapters

### New Transport (e.g., JSON-RPC over HTTP)

1. Create `src/transports/jsonrpc-http/adapter.ts`
2. Map JSON-RPC methods to `MessagingService` / `BrainService` calls
3. Add wiring in `main.ts` — same services, different transport
4. Use the cross-process poller for notification delivery — the in-process
   dispatcher is being removed (see §Honest Accounting)

### New Storage Backend (e.g., Postgres)

1. Create `src/storage/postgres/` with implementations of all repository ports
2. Create a factory `createPostgresRepos(connection)`
3. Swap in `main.ts` — services don't change

### New Notification Adapter (e.g., SSE)

1. Create `src/notifications/sse-notifier/notifier.ts`
2. Wire a poller with raw query functions for cross-process delivery (the in-process
   dispatcher is being removed)
3. Deliver via SSE stream instead of MCP channel notification
4. Wire in `main.ts`

In all cases: core doesn't change, existing adapters don't change, only new files
are added plus wiring in the composition root.

## Honest Accounting: Notification Architecture

This section documents architectural tensions in the notification system. The
codebase works correctly, but the design carries trade-offs that should be
understood by anyone extending it.

### How we got here

The original notification system (pre-v0.7.0) was a 3-second polling loop
(`createClaudeNotifier`) that called `MessagingService.getUndelivered()` — 60 lines
of domain logic in core that existed solely to serve the notification adapter. This
worked cross-process (each process polled SQLite independently) but had two bugs:

- **Bug #7**: `subscribe()` initialized the read cursor to `maxId`, hiding
  pre-existing messages from new subscribers.
- **Bug #8**: The read path and notification path shared cursor state, causing
  races that suppressed push notifications.

The Phase 0-pre roadmap item replaced this with event-driven dispatch: core calls
`NotificationDispatch.dispatch()` synchronously on `send()`, eliminating polling,
`getUndelivered()`, and the shared cursor. Bugs #7 and #8 were fixed by
construction.

**The design missed one thing:** each Claude Code agent runs in its own process.
The in-memory dispatcher in process A has no handler for Agent B (process B).
Cross-process notification was silently broken. Within 24 hours, a cross-process
poller was added alongside the dispatcher to restore delivery.

### What this means

The roadmap's Phase 0-pre vision was "eliminate polling." What shipped is:

1. **Dispatcher** — in-process, event-driven, zero-latency. Currently dead code
   (single agent per process). Originally retained for a future multi-agent-per-process
   transport (Phase 3b direct mode). **That future has been retracted (2026-05-16):**
   modern coding harnesses (Claude Code, Cursor, etc.) provide subagents at the harness
   layer, with each subagent running as its own process. Building an in-process
   multi-agent MCP transport would reinvent the wheel. The dispatcher is scheduled for
   removal — see `docs/specs/2026-05-16-notification-dispatch-consolidation-prd.md`.
2. **Poller** — cross-process, 2-second interval, reads SQLite. The mechanism that
   actually delivers notifications today, and will be the sole push mechanism after
   the dispatcher is removed. Architecturally similar to the old notifier it replaced,
   but with key improvements (independent HWM, simpler query, adapter-level mention
   filtering, no core domain coupling).
3. **Pull** — `read_messages` / future `messaging_listen`. Always available as
   fallback. Messages are never lost (SQLite persistence). Current push is
   best-effort; as transports mature, adapter-level push reliability improves.

### Resolved: `NotificationQueryPort` removed from core (2026-04-11)

The original poller implementation placed `NotificationQueryPort` in
`src/core/ports.ts` — an adapter-shaped port that violated principle 3. The
poller spec had already specified it should live in `src/notifications/ports.ts`,
but the implementation deviated due to the boundary test constraint ("storage
must not depend on notifications").

**Fix:** The named interface was removed entirely. The poller now takes raw
query functions (`getNewMessagesForAgent`, `getMaxMessageId`) injected from the
composition root. `SqliteNotificationQueryRepo` remains in storage as an internal
class — no core port, no pretense of generality. Polling is adapter-internal.
When real push arrives (MCP 2.0, message queue), delete the poller and its
wiring. Core unchanged.

### The fundamental constraint

Cross-process communication over SQLite inherently requires reading shared state.
That means polling (or OS-level file watchers, which are more complex and less
portable). Event-driven dispatch solves same-process delivery elegantly but cannot
cross the process boundary without an IPC bridge.

For octo-santa's N-process model (each agent is its own subprocess sharing a SQLite
file), **some form of polling will always be needed for cross-process notification.**
Future work (MCP 2.0 server-initiated push, `messaging_listen` long-poll) may
change the delivery mechanism, but the shared-SQLite-requires-polling constraint
remains until the process model changes.
