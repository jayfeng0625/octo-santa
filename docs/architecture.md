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
- **Cross-process delivery requires watching SQLite.** Anything that needs to
  reach another process must go through the database. Accept this constraint;
  don't design around it.
- **`notifications/claude/channel` only works over stdio.** Claude's push mechanism
  is non-standard and transport-specific. Non-Claude clients and HTTP transports
  cannot use it.
- **Core writes; adapters deliver.** Push is best-effort (N-process model, 2s
  SQLite watcher). Poll (`messaging_read_messages`) is always available as
  fallback. Messages are never lost — SQLite persistence is the invariant.

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
      notification-query-repo.ts ← Internal class for notification watcher queries
      index.ts                   ← Factory: createSqliteRepos(db)
      db.ts                      ← createDb(), withRetrySync()
      migrations.ts              ← Schema migrations

  transports/                    ← Transport adapters (how external clients connect)
    mcp-stdio/
      adapter.ts                 ← MCP tool registration, agent binding, server startup
      helpers.ts                 ← jsonResult(), withAgent()

  notifications/                 ← Notification adapter (how agents receive push)
    poller/
      poller.ts                  ← Watches SQLite (2s interval), pushes MCP channel notifications

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
| `NotificationPort` | Push delivery contract shared by the notification and transport adapters |

Core does not deliver notifications. `send()` extracts mentions and persists the
message; delivery is entirely an adapter concern. `NotificationPort` lives in
`core/ports.ts` only so both adapters can depend on it without importing each
other.

### Services

**`MessagingService`** orchestrates business logic through port interfaces —
registration, channels, messaging, DMs, mentions, cursor management.

The service is a process-scoped singleton. It holds `process.pid` for agent
ownership checks.

### Domain Utilities (`core/utils.ts`)

Pure functions with no dependencies: `validateAgentName()`, `isDmChannel()`,
`extractMentions()`, `isAgentActive()`, `isProcessAlive()`.

## How the Layers Connect

### Send path

```
  Transport          Core Service          Storage
  (MCP stdio)        (MessagingService)    (SQLite repos)
      │                     │                    │
      │  send("hi @bob")    │                    │
      ├────────────────────►│                    │
      │                     │  extract mentions  │
      │                     │  messageRepo       │
      │                     │  .insertAndJoin()  │
      │                     ├───────────────────►│
      │                     │◄───────────────────┤
      │◄────────────────────┤                    │
      │  return Message     │                    │
```

### Push delivery (SQLite watcher → MCP notification)

```
  Watcher             Storage              Transport
  (in Bob's process)  (shared SQLite)      (Bob's MCP session)
      │                    │                    │
      │  [every 2s]        │                    │
      │  getNewMessages    │                    │
      │  ForAgent("bob",   │                    │
      │    hwm, 100)       │                    │
      ├───────────────────►│                    │
      │◄───────────────────┤                    │
      │  messages since    │                    │
      │  last HWM          │                    │
      │                    │                    │
      │── mention filter   │                    │
      │── port.notify() ──────────────────────►│  notifications/claude/channel
      │── advance HWM      │                    │  → <channel> tag in conversation
```

The service only writes to storage. Delivery happens independently in each
receiving agent's process — the database is the cross-process message bus.

## Cross-Cutting Concerns

### 1. Notification Delivery

**Push — Claude channel notifications via MCP** (`src/notifications/poller/`):
Each agent's server process runs a `setInterval` (default 2s,
`OCTO_SANTA_POLL_INTERVAL_MS`) that watches SQLite via raw query functions
injected from the composition root, and pushes matching messages to its bound
agent as `notifications/claude/channel` MCP notifications. It uses an
adapter-owned high-water mark (HWM) completely independent of the read cursor,
and filters on the pre-extracted `mentions` column (DM channels always notify;
regular channels notify on `@agent` or `@all`).

**Poll — reading SQLite** (`messaging_read_messages`): cursor-tracked reads,
always available, intended for programmatic use. Push is best-effort; messages
are never lost because SQLite persistence is the invariant.

The watcher takes raw query functions (`getNewMessagesForAgent`, `getMaxMessageId`)
rather than a named core port — watching SQLite is adapter-internal, and
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
its watcher.

### 5. Cursor Tracking

Service manages read cursors via repos. `readForwardAndAdvance()` atomically reads
and advances the cursor. The notification watcher maintains its own high-water mark
(HWM) in memory — completely independent of the read cursor. This independence
matters: sharing cursor state between the read path and the notification path
creates races that suppress push notifications.

**The pattern:** service writes to storage. Cross-process delivery goes through
SQLite (the watcher). No adapter-to-adapter communication. The database is the
cross-process message bus.

## Bootstrap Flow

The composition root (`src/main.ts`) wires everything top-down:

1. **Storage** — create DB, run migrations, create all repos + notification query class
2. **Core service** — inject repos into `MessagingService`
3. **Transport adapter** — register MCP tools, set up agent binding with:
   - `startPoller` factory (creates and starts the SQLite watcher on agent bind)
   - Heartbeat timer (10s interval)
4. **Connect** — start stdio transport, set up disconnect handler

The watcher starts lazily — only when an agent registers and binds. On disconnect,
it is stopped and the agent is unregistered.

## Adding New Adapters

### New Transport (e.g., JSON-RPC over HTTP)

1. Create `src/transports/jsonrpc-http/adapter.ts`
2. Map JSON-RPC methods to `MessagingService` calls
3. Add wiring in `main.ts` — same services, different transport
4. Reuse the SQLite watcher for push delivery

### New Storage Backend (e.g., Postgres)

1. Create `src/storage/postgres/` with implementations of all repository ports
2. Create a factory `createPostgresRepos(connection)`
3. Swap in `main.ts` — services don't change

### New Notification Adapter (e.g., SSE)

1. Create `src/notifications/sse-notifier/notifier.ts`
2. Wire a SQLite watcher with raw query functions for cross-process delivery
3. Deliver via SSE stream instead of MCP channel notification
4. Wire in `main.ts`

In all cases: core doesn't change, existing adapters don't change, only new files
are added plus wiring in the composition root.

## The Fundamental Constraint

Cross-process communication over SQLite inherently requires reading shared state.
That means periodically re-reading the database (or OS-level file watchers, which
are more complex and less portable). In-memory event dispatch cannot cross the
process boundary without an IPC bridge.

For octo-santa's N-process model (each agent is its own subprocess sharing a SQLite
file), **some form of polling will always be needed for cross-process notification.**
Future work (MCP 2.0 server-initiated push, long-poll transports) may change the
delivery mechanism, but the shared-SQLite-requires-polling constraint remains until
the process model changes.
