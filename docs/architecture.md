---
title: Architecture
summary: Hexagonal architecture overview — ports, adapters, notification delivery, bootstrap flow
tags: [architecture, hexagonal, ports-and-adapters]
---

# Architecture

octo-santa uses hexagonal architecture (ports and adapters). The core domain defines
interfaces; adapters implement them. Storage, transport, and notification concerns are
independently swappable.

## North Star

octo-santa is a local-first agent messaging layer. Agents on the same machine
discover each other and communicate through channels — without servers, accounts,
or network access. A single SQLite file (`messages.db`) is the entire backend.

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
- **Cross-process delivery requires polling.** Event-driven dispatch works
  in-process only. Anything that needs to reach another process must go through
  SQLite. Accept this constraint; don't design around it.
- **`notifications/claude/channel` only works over stdio.** Claude's push mechanism
  is non-standard and transport-specific. Non-Claude clients and HTTP transports
  cannot use it.
- **Core dispatches push statelessly; adapters own delivery reliability.** Push is
  best-effort (N-process model, 2s poller). Pull (`messaging_read_messages`,
  `messaging_listen`) is always available as fallback. Messages are never lost —
  SQLite persistence is the invariant.

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
    ports.ts                     ← All port interfaces (repositories, notification)
    utils.ts                     ← Pure domain utilities (validation, mention parsing, liveness)

  storage/                       ← Storage adapters
    sqlite/                      ← SQLite implementation of all repository ports
      agent-repo.ts
      channel-repo.ts
      message-repo.ts
      cursor-repo.ts
      notification-query-repo.ts ← Internal class for cross-process poller queries
      index.ts                   ← Factory: createSqliteRepos(db)
      db.ts                      ← createDb(), withRetrySync()
      migrations.ts              ← Schema migrations

  transports/                    ← Transport adapters (how external clients connect)
    mcp-stdio/
      adapter.ts                 ← MCP tool registration, agent binding, server startup
      helpers.ts                 ← jsonResult(), withAgent()

  notifications/                 ← Notification adapters (how agents receive push)
    dispatch/
      dispatcher.ts              ← In-process event-driven dispatch (fires on send())
    poller/
      poller.ts                  ← Cross-process SQLite poller (2s interval)

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
| `AgentRepository` | Agent registration, heartbeat, liveness |
| `ChannelRepository` | Channel CRUD, membership, rename with announcement |
| `MessageRepository` | Message insert, cursor-advancing reads, history reads |
| `CursorRepository` | Read cursor tracking per agent per channel |
| `NotificationPort` | Push delivery contract (transport-agnostic) |
| `NotificationDispatch` | Event-driven dispatch — core calls on `send()` |

Core is push-first. `NotificationDispatch` is the sole notification interface
in core — it says "push this to these agents." How delivery happens (in-process
dispatch, cross-process polling) is an adapter concern. No polling interfaces
live in core.

### Services

**`MessagingService`** orchestrates business logic through port interfaces —
registration, channels, messaging, DMs, mentions, cursor management. On `send()`,
resolves mention targets and invokes `NotificationDispatch` for in-process
event-driven push.

The service is a process-scoped singleton. It holds `process.pid` for agent
ownership checks.

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
Because each agent runs in its own process (one bound agent per MCP server), the
dispatcher only ever finds handlers for agents in the sending process — in the
standard deployment, cross-process targets are always misses.
`docs/specs/2026-05-16-notification-dispatch-consolidation-prd.md` records the
decision to eventually delete it and make the poller the sole push mechanism.

**Cross-process poller** (`src/notifications/poller/`): Each process runs a
`setInterval` (default 2s, `OCTO_SANTA_POLL_INTERVAL_MS`) that queries SQLite via
raw functions injected from the composition root. Uses an adapter-owned high-water
mark (HWM) completely independent of the read cursor. Mention filtering happens at
the adapter level using the pre-extracted `mentions` column. **This is the
mechanism that actually delivers notifications.**

**Pull** — `messaging_read_messages` and `messaging_listen` are always available
as fallback. Push is best-effort; messages are never lost because SQLite
persistence is the invariant.

The poller takes raw query functions (`getNewMessagesForAgent`, `getMaxMessageId`)
rather than a named core port — polling is adapter-internal, and
`SqliteNotificationQueryRepo` stays in storage as an internal class.

### 2. Agent Liveness

The MCP transport adapter runs a heartbeat timer that calls
`agentRepo.heartbeatOrReclaim()` every 10 seconds. This updates `last_seen_at` in
storage. The service uses `isAgentActive()` to filter agents in `listAgents()`
and `listMembers()`. Liveness is transport-independent.

### 3. Agent Registration and Disconnect

The service handles `register()` and `unregister()` as pure storage operations.
Transport adapters manage session lifecycle — MCP stdio binds the session to the
first agent that completes a tool call and unregisters on close. The service
doesn't know the trigger.

### 4. DM Channel Creation

Service creates the DM channel, subscribes both agents, and sends the message —
all storage writes. Each party's process picks up the new message from SQLite via
its poller.

### 5. Cursor Tracking

Service manages read cursors via repos. `readForwardAndAdvance()` atomically reads
and advances the cursor. The notification poller maintains its own high-water mark
(HWM) in memory — completely independent of the read cursor. This independence
matters: sharing cursor state between the read path and the notification path
creates races that suppress push notifications.

**The pattern:** service writes to storage. Cross-process delivery goes through
SQLite (the poller). No adapter-to-adapter communication. The database is the
cross-process message bus.

## Bootstrap Flow

The composition root (`src/main.ts`) wires everything top-down:

1. **Storage** — create DB, run migrations, create all repos + notification query class
2. **Notification dispatcher** — create in-process dispatcher
3. **Core service** — inject repos and dispatcher into `MessagingService`
4. **Transport adapter** — register MCP tools, set up agent binding with:
   - `registerNotificationHandler` / `unregisterNotificationHandler` (dispatcher)
   - `startPoller` factory (creates and starts cross-process poller on agent bind)
   - Heartbeat timer (10s interval)
5. **Connect** — start stdio transport, set up disconnect handler

The poller starts lazily — only when an agent registers and binds. On disconnect,
the poller is stopped and the agent's handler is unregistered from the dispatcher.

## Adding New Adapters

### New Transport (e.g., JSON-RPC over HTTP)

1. Create `src/transports/jsonrpc-http/adapter.ts`
2. Map JSON-RPC methods to `MessagingService` calls
3. Add wiring in `main.ts` — same services, different transport
4. Use the cross-process poller for notification delivery

### New Storage Backend (e.g., Postgres)

1. Create `src/storage/postgres/` with implementations of all repository ports
2. Create a factory `createPostgresRepos(connection)`
3. Swap in `main.ts` — services don't change

### New Notification Adapter (e.g., SSE)

1. Create `src/notifications/sse-notifier/notifier.ts`
2. Wire a poller with raw query functions for cross-process delivery
3. Deliver via SSE stream instead of MCP channel notification
4. Wire in `main.ts`

In all cases: core doesn't change, existing adapters don't change, only new files
are added plus wiring in the composition root.

## The Fundamental Constraint

Cross-process communication over SQLite inherently requires reading shared state.
That means polling (or OS-level file watchers, which are more complex and less
portable). Event-driven dispatch solves same-process delivery elegantly but cannot
cross the process boundary without an IPC bridge.

For octo-santa's N-process model (each agent is its own subprocess sharing a SQLite
file), **some form of polling will always be needed for cross-process notification.**
Future work (MCP 2.0 server-initiated push, long-poll transports) may change the
delivery mechanism, but the shared-SQLite-requires-polling constraint remains until
the process model changes.
