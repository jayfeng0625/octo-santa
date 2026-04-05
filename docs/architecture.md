---
title: Architecture
summary: Hexagonal architecture overview — ports, adapters, cross-cutting concerns, bootstrap flow
tags: [architecture, hexagonal, ports-and-adapters]
---

# Architecture

octo-santa uses hexagonal architecture (ports and adapters). The core domain defines
interfaces; adapters implement them. Storage, transport, and notification concerns are
independently swappable.

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

  storage/                       ← Storage adapters
    sqlite/                      ← SQLite implementation of all repository ports
      agent-repo.ts
      channel-repo.ts
      message-repo.ts
      cursor-repo.ts
      domain-repo.ts
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
    claude-notifier/
      notifier.ts                ← Polling loop + Claude channel delivery

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
| `NotificationPort` | Push delivery (transport-agnostic) |

### Services

Two services orchestrate business logic through port interfaces:

**`MessagingService`** — registration, channels, messaging, DMs, mentions, cursor
management, and `getUndelivered()` (the domain query that determines who should
receive what, used by notification adapters).

**`BrainService`** — brain document indexing/reading, domain registration/claiming,
expert discovery.

Services are process-scoped singletons. They hold `process.pid` for agent ownership
checks.

### Domain Utilities (`core/utils.ts`)

Pure functions with no dependencies: `validateAgentName()`, `isDmChannel()`,
`extractMentions()`, `isAgentActive()`, `isProcessAlive()`.

## How the Layers Connect

```
  Transport          Core Service          Storage
  (MCP stdio)        (MessagingService)    (SQLite repos)
      │                     │                    │
      │  send("hi")         │                    │
      ├────────────────────►│                    │
      │                     │  messageRepo       │
      │                     │  .insertAndJoin()  │
      │                     ├───────────────────►│
      │                     │                    │── write to DB
      │                     │◄───────────────────┤
      │◄────────────────────┤                    │
      │  return Message     │                    │


  Notification       Core Service          Storage
  (Claude notifier)  (MessagingService)    (SQLite repos)
      │                     │                    │
      │  getUndelivered()   │                    │
      ├────────────────────►│                    │
      │                     │  cursorRepo, etc.  │
      │                     ├───────────────────►│
      │                     │◄───────────────────┤
      │◄────────────────────┤                    │
      │  PendingNotification│                    │
      │                     │                    │
      │── push via channel notification          │
```

The service writes to storage and answers queries. It never pushes anything.
Notification adapters poll the service independently and deliver via their own mechanism.

## Cross-Cutting Concerns

Six areas where the service writes to storage and adapters independently react:

### 1. Message Delivery

Service inserts message into storage. Each notification adapter polls
`getUndelivered()` on its own tick and delivers via its transport. An agent on MCP
stdio and an agent on a future HTTP transport both receive the same message —
neither knows the other's transport.

### 2. Agent Liveness

Each notification adapter calls `agentRepo.heartbeatOrReclaim()` on its polling
tick. This updates `last_seen_at` in storage. The service uses `isAgentActive()`
to filter agents in `listAgents()`, `listMembers()`, and `findExperts()`. Liveness
is transport-independent.

### 3. Agent Registration and Disconnect

The service handles `register()` and `unregister()` as pure storage operations.
Transport adapters manage session lifecycle — MCP stdio calls register on first
tool call and unregister on close. A future HTTP adapter might use session timeouts.
The service doesn't know the trigger.

### 4. DM Channel Creation

Service creates the DM channel, subscribes both agents, and sends the message —
all storage writes. Both agents' notification adapters independently discover the
new message via `getUndelivered()`.

### 5. Brain Domain Discovery

Service handles `claimDomain()` (write) and `findExperts()` (read + liveness
filter). Transport adapters just expose the tools.

### 6. Cursor Tracking

Service manages cursors via repos. `readForwardAndAdvance()` atomically reads and
advances the cursor. Notification adapters maintain their own high-water mark (HWM)
maps in memory for push deduplication. The DB cursor is the source of truth.

**The pattern is always the same:** service writes to storage, adapters poll
independently, storage is the single source of truth. No adapter-to-adapter
communication. The database is the message bus.

## Bootstrap Flow

The composition root (`src/main.ts`) wires everything top-down:

1. **Storage** — create DB, run migrations, create all repos
2. **Brain store** — read config, create filesystem store
3. **Core services** — inject repos into services
4. **Domain registration** — register domain metadata if configured
5. **MCP server + notification port** — create server, create notification port from it
6. **Transport adapter** — register MCP tools pointing at services, set up agent binding
7. **Connect** — start stdio transport, set up disconnect handler

The notifier starts lazily — only when an agent first registers. Until then, no
polling loop runs.

## Adding New Adapters

### New Transport (e.g., JSON-RPC over HTTP)

1. Create `src/transports/jsonrpc-http/adapter.ts`
2. Map JSON-RPC methods to `MessagingService` / `BrainService` calls
3. Add wiring in `main.ts` — same services, different transport

### New Storage Backend (e.g., Postgres)

1. Create `src/storage/postgres/` with implementations of all repository ports
2. Create a factory `createPostgresRepos(connection)`
3. Swap in `main.ts` — services don't change

### New Notification Adapter (e.g., SSE)

1. Create `src/notifications/sse-notifier/notifier.ts`
2. Implement its own polling loop calling `messagingService.getUndelivered()`
3. Deliver via SSE stream instead of MCP notification
4. Wire in `main.ts` with an SSE-based `NotificationPort`

In all cases: core doesn't change, existing adapters don't change, only new files
are added plus wiring in the composition root.
