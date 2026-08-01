# Hexagonal Architecture Design Spec

Refactor octo-santa from its current module-based architecture to hexagonal (ports and
adapters). The core domain defines interfaces; adapters implement them. Existing behavior
is preserved with accepted deviations documented in section 5.

**Reference documents:**
- [Architecture overview](../architecture.md) — runtime architecture and cross-cutting concerns

---

## 1. Core Domain

The core contains pure business logic with no infrastructure imports. No database drivers,
no protocol libraries, no transport-specific code.

### 1.1 Port Interfaces

All port interfaces defined in a single file. The core defines these; adapters implement
them.

**Storage ports:**

```typescript
interface AgentRepository {
  findById(id: string): Agent | null;
  register(agentId: string, pid: number): Agent;
      // Internally transactional: check liveness, upsert
  heartbeatOrReclaim(agentId: string, pid: number): HeartbeatResult;
      // Atomic: try heartbeat → if stale, CAS reclaim → return 'ok' | 'lost'
  listAll(): Agent[];
  clearPid(id: string, expectedPid: number): void;
}

interface ChannelRepository {
  findByName(name: string): Channel | null;
  create(name: string, createdBy: string): Channel;
  list(): Channel[];
  addMember(agentId: string, channelId: number, initialCursorId: number): void;
      // Cursor upsert with conflict-ignore. The service chooses the initial cursor
      // value to support three distinct behaviors:
      //   subscribe → current max message ID (no backlog flood)
      //   sender auto-join → 0 (sender sees prior messages on next read)
      //   DM setup → current max message ID (both parties start fresh)
  getMembers(channelId: number): Agent[];
  getMemberCount(channelId: number): number;
  getMaxMessageId(channelId: number): number;
  renameWithAnnouncement(channelId: number, newName: string, agentId: string): Channel;
      // Atomic: rename channel + insert system message with @all mention.
      // System message uses a reserved sender (not the renaming agent) so all
      // agents — including the renamer — see it via standard read flow.
}

interface MessageRepository {
  insertAndJoinSender(channelId: number, agentId: string, content: string, mentions: string[]): Message;
      // Atomic: insert message + upsert sender cursor (conflict-ignore)
  readForwardAndAdvance(agentId: string, channelId: number, limit: number): Message[];
      // Atomic: read cursor → fetch messages since cursor → advance cursor.
      // Self-exclusion: excludes messages by the reading agent.
  readBefore(channelId: number, beforeId: number, limit: number, excludeAgent: string): Message[];
  countSince(channelId: number, sinceId: number, excludeAgent: string): number;
  readSince(channelId: number, sinceId: number, limit: number, excludeAgent: string): Message[];
      // Non-cursor-advancing read, used by getUndelivered
}

interface CursorRepository {
  get(agentId: string, channelId: number): number;
  upsert(agentId: string, channelId: number, messageId: number): void;
  listForAgent(agentId: string): CursorWithChannel[];
}

interface DomainRepository {
  register(identifier: string, cwd: string, tags: string[], description: string): void;
  claim(agentId: string, pid: number, domainIdentifier: string): void;
  listWithClaims(): DomainWithClaims[];
  clearClaims(agentId: string, pid: number): void;
}

interface BrainStore {
  scanDocs(): BrainDoc[];
  readDoc(slug: string): string;
  scanSharedDocs(): BrainDoc[];
  readSharedDoc(slug: string): string;
}
```

**Notification port:**

```typescript
interface NotificationPort {
  notify(content: string, meta: Record<string, string>): Promise<void>;
}
```

### 1.2 Core Types

**Messaging types:**
- `Agent` — `{ id, created_at, last_seen_at, pid, registered_at }`
- `Channel` — `{ id, name, created_by, created_at }`
- `Message` — `{ id, channel_id, agent_id, content, created_at, mentions }`
- `ChannelMember` — `{ agent_id, active }`
- `ReadOptions` — `{ limit?, before_id? }`
- `PendingNotification` — `{ channelName, messages, isDm }`. DM detection is
  structural: channel name matches sorted pair pattern AND both named agents have
  cursors. This is NOT count-based — observers joining a DM channel do not flip
  it to group mode.
- `CursorWithChannel` — `{ channelId, channelName, lastReadMessageId }`
- `HeartbeatResult` — `'ok' | 'lost'`

**Brain types:**
- `DomainConfig`, `BrainConfig`, `OctoSantaConfig`
- `BrainDoc` — `{ slug, path, title, summary, tags }`
- `Domain` — `{ identifier, cwd, tags, description, registered_at }`
- `DomainClaim` — `{ agent_id, pid, domain_identifier, claimed_at }`
- `DomainExpert` — `{ identifier, tags, description, active_sessions }`

### 1.3 Domain Utilities

Pure functions with no dependencies:

```typescript
isDmChannel(name: string): boolean
assertDmAccess(channelName: string, agentId: string): void
extractMentions(content: string, validAgentIds: string[]): string[]
validateAgentName(agentId: string): void    // rejects reserved names: all, here, _system
isProcessAlive(pid: number): boolean
isAgentActive(agent: Agent): boolean
```

### 1.4 Service Layer

Two core services orchestrate business logic through port interfaces. No infrastructure
imports.

**State model:** Services are process-scoped singletons. They hold `process.pid` at
construction for ownership checks. One service instance per process, one agent binding
per process.

**MessagingService**

Constructor dependencies: `AgentRepository`, `ChannelRepository`, `MessageRepository`,
`CursorRepository`, `pid: number`.

| Method | Behavior |
|--------|----------|
| `register(agentId)` | Validates name, delegates to agent repo |
| `unregister(agentId, pid)` | Delegates to agent repo |
| `createChannel(agentId, name)` | Checks registration, delegates to channel repo |
| `subscribe(agentId, channelName)` | Checks registration + DM access, computes initial cursor, delegates to channel repo |
| `send(agentId, channelName, content)` | Checks registration + DM access, extracts mentions, delegates to message repo (atomic: insert + sender auto-join) |
| `read(agentId, channelName, opts?)` | Checks registration + membership. Forward: atomic read + cursor advance. History: read without cursor change. |
| `directMessage(agentId, targetId, content)` | Validates target, computes DM channel name (sorted), creates channel, subscribes both, sends. Individual repo calls — not wrapped in single transaction (see accepted deviations). |
| `renameChannel(agentId, channelName, newName)` | Checks membership, delegates to channel repo (atomic: rename + system announcement) |
| `listChannels()` | Delegates to channel repo |
| `listAgents(includeStale?)` | Lists all agents, filtered by liveness |
| `listMembers(channelName)` | Lists members enriched with liveness |
| `readRecent(channelId, limit)` | Returns recent messages WITHOUT self-exclusion. Used by REPL for history display. |
| `getUndelivered(agentId, hwm?)` | Cross-aggregate domain query (see below) |

**`getUndelivered(agentId, hwm?: Map<number, number>): PendingNotification[]`**

The domain eligibility query. Accepts an optional high-water mark map from the
notification adapter. Orchestrates across repos:

1. Get subscribed channels with cursor positions
2. For each channel: compute lower bound as `max(cursor, hwm)`, check for unread
3. Determine DM vs group. DM detection is structural (sorted-pair name + both named
   agents have cursors)
4. Group channels: fetch unread, scan mentions — notify only if any message targets
   the agent (`@agentId` or `@all`). If triggered, include the full unread batch.
5. DM channels: notify on any unread (no mention filter)
6. Return `PendingNotification[]`

**BrainService**

Constructor dependencies: `BrainStore`, `DomainRepository`, `AgentRepository`,
`config: OctoSantaConfig | null`.

| Method | Behavior |
|--------|----------|
| `index()` | Delegates to brain store |
| `read(slug)` | Delegates to brain store |
| `sharedIndex()` | Delegates to brain store |
| `sharedRead(slug)` | Delegates to brain store |
| `findExperts()` | Lists domains with claims, filtered by agent liveness |
| `claimDomain(agentId)` | Checks registration, delegates to domain repo |
| `registerDomain()` | Registers domain metadata from config. No-op if unconfigured. |
| `onDisconnect(agentId, pid)` | Clears domain claims |

**Key design rules:**
1. Services have NO knowledge of transport or storage implementation.
2. Registration checks verify agent existence AND PID ownership. The service holds
   `process.pid` as instance state.
3. Domain logic (validation, DM access, mentions) is extracted unchanged into
   utilities and services. Storage queries are extracted unchanged into repos.
   The service glue wiring them together is new code.

### 1.5 Design Rationale

Key architectural decisions and why they were made:

**Transactions are a storage concern, not a service concern.** Repository methods
are coarse enough to encapsulate atomicity internally. The core service never calls
`beginTransaction()` or uses transaction vocabulary. Instead, repo methods like
`register()` or `readForwardAndAdvance()` are internally transactional — the storage
adapter uses whatever mechanism it has (SQLite's `.exclusive()`, Postgres's
`BEGIN ... COMMIT`, etc.). The interface contract documents what must not race; the
adapter delivers the guarantee. This keeps the core free of storage-specific concepts
while preserving correctness.

**The polling loop belongs to the notification adapter, not the core.** The core
says "here's what's unread for agent X" via `getUndelivered()` — it doesn't know
about polling intervals, high-water marks, or coalescing. The notification adapter
manages its own delivery lifecycle. This means different adapters can use different
strategies (polling, SSE push, webhooks) without the core changing. The adapter
receives a read-only query path into the service for eligibility checks.

---

## 2. Adapters

### 2.1 Storage Adapters

**SQLite adapter** — implements all repository ports. Each repo is a separate unit
sharing one database connection via a factory function.

Coarse repo methods encapsulate atomicity:
- `register()` — exclusive transaction (check liveness + upsert)
- `heartbeatOrReclaim()` — atomic heartbeat + compare-and-swap reclaim
- `readForwardAndAdvance()` — immediate transaction (cursor read + message fetch + cursor advance)
- `insertAndJoinSender()` — immediate transaction (insert message + upsert sender cursor)
- `renameWithAnnouncement()` — immediate transaction (rename + system message)

Simple writes are individually atomic — no multi-statement transactions needed.

**Filesystem brain store** — implements `BrainStore`. Constructed with resolved config
at bootstrap time. Methods scan configured directories for markdown files, parsing
optional frontmatter for metadata (title, summary, tags). Files without frontmatter
are included with defaults derived from filename.

### 2.2 Transport Adapters

**MCP stdio** — creates MCP server, registers all tools (messaging + brain), maps
tool calls to service methods. Agent binding (one agent per process, deferred commit
pattern) lives here. The external MCP tool interface is identical — same names, same
schemas, same output format.

**REPL** — terminal UI for human participation. Calls service methods for all
messaging operations. Has its own polling loop for live message display (separate
from the notification adapter's loop). Rendering, buffer management, and key handling
are transport concerns.

### 2.3 Notification Adapters

**Claude notifier** — polling loop that calls `messagingService.getUndelivered()`
each tick and delivers via a `NotificationPort` implementation.

The adapter owns:
- Polling interval and timer lifecycle
- High-water mark tracking (prevents re-push without cursor advance)
- Message coalescing (single message vs summary format)
- Heartbeat via `agentRepo.heartbeatOrReclaim()` each tick
- Delivery via `notificationPort.notify()`

The adapter calls core for domain logic:
- `messagingService.getUndelivered(agentId, hwmMap)` — passes its HWM map each tick.
  The service computes eligibility. DM detection, mention filtering, and self-exclusion
  are all handled by core.

The `NotificationPort` implementation is created in the composition root as a thin
wrapper around the transport's notification mechanism. This keeps the notifier
decoupled — future SSE/webhook notifiers provide a different `NotificationPort`.

---

## 3. Composition

The composition root is the single place where adapters, services, and repos are
created and wired. It follows a top-down flow:

```
1. Create storage (DB, migrations, repos)
2. Create brain store (resolve config, create filesystem store)
3. Create core services (inject repos)
4. Register domain metadata (if configured)
5. Create transport (MCP server, notification port)
6. Register tools (pointing at services)
7. Connect transport, set up disconnect handlers
```

The notification adapter starts lazily — only when an agent first registers. Until
then, no polling loop runs. Code-driven composition (direct construction and wiring)
is used. Config-driven composition is a future consideration once multiple adapters
exist per port.

---

## 4. Boundary Rules

These are enforced by architecture tests and are non-negotiable:

1. **Core isolation** — core must NOT import from storage, transports, or notifications.
   Core must NOT import infrastructure libraries (database drivers, protocol SDKs).
2. **Cross-adapter isolation** — no imports between storage, transports, and
   notifications in any direction.
3. **Dependency direction** — adapters depend on core (port interfaces). Core depends
   on nothing external.
4. **Backward compatibility** — same MCP tools, same notifications, same agent
   lifecycle, same database schema. External behavior is identical.

---

## 5. Accepted Deviations

Intentional behavior changes from the pre-refactor implementation:

1. **`directMessage` atomicity relaxed.** Previously wrapped create-channel +
   subscribe-both + send in one transaction. The hex architecture calls individual
   repo methods without a wrapping transaction. Failure partway through is recoverable
   (channel created, message unsent; agent retries). Rationale: the DM flow involves
   domain logic that belongs in the service, not a monolithic repo method.

2. **Domain registration timing shifted.** Previously happened during MCP tool
   registration. Now happens at composition root bootstrap. Effect is identical
   (domain registered before any tool calls) but REPL entrypoints now also trigger
   domain registration. This is acceptable.

---

## 6. Design Constraints

- **Behavior preservation.** Domain logic, validation rules, and error messages are
  extracted unchanged. The service glue wiring domain logic to repo calls is new code.
- **Bug fixes are auditable.** Any bug discovered during extraction gets its own
  commit with clear justification. Never mixed with extraction commits.
- **Notification output contract.** The notification meta fields (`channel_name`,
  `sender`, `message_id`) and coalescing format (`"N new messages on CHANNEL:\n"` with
  `[i] sender: content` previews, truncated at 150 chars) must be preserved exactly.
