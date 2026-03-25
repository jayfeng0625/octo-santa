# Octo-Santa Messaging Module — Design Spec

## Overview

Octo-santa is a multi-module MCP server that provides shared capabilities to AI coding agents (Claude Code sessions) on the same machine. The messaging module is its first feature: a channel-based messaging system that enables agents across different project repositories to communicate with near-instant delivery and 99.99% deliverability.

## Architecture: SQLite-as-IPC

Each Claude Code session spawns its own octo-santa MCP server process via stdio. All processes share a single SQLite database file (`~/.octo-santa/messages.db`). SQLite is the message bus — no hub server, no network layer, no long-running process to manage.

### Why SQLite-as-IPC

- **Zero infrastructure** — no server to start or manage. Claude Code spawns the process automatically.
- **Resource efficient** — processes only exist while agents are active.
- **Crash resilient** — WAL journal handles recovery. Incomplete writes roll back, DB stays consistent.
- **Simple** — one file, one source of truth, well-understood concurrency model.

### Concurrency Model

SQLite WAL mode provides:
- Multiple concurrent readers without blocking
- Readers don't block writers
- Atomic writes

Write contention is handled by:
1. `PRAGMA busy_timeout = 5000` — SQLite retries internally for up to 5 seconds
2. Application-level retry with exponential backoff (2-3 retries) if BUSY persists
3. At our scale (handful of agents, low write frequency), contention is negligible

### Deliverability Guarantee (99.99%)

- `send_message` returns an explicit success with message ID, or an explicit error
- If the tool returns success, the message is durable in SQLite
- If it returns failure, the agent knows and can retry
- `PRAGMA synchronous=NORMAL` with WAL — data survives process crashes
- Application-level retry ensures transient BUSY errors don't cause message loss

## Data Model

### Tables

**`agents`** — self-registered on first tool call
- `id` (text, PK) — self-declared name, typically the project repo name (e.g., `octo-santa`, `payment-service`)
- `created_at` (integer) — unix timestamp ms
- `last_seen_at` (integer) — updated on tools that carry agent identity (register, create_channel, send_message, read_messages)

**`channels`** — named conversation spaces
- `id` (integer, PK, autoincrement)
- `name` (text, unique) — e.g., `coordination`, `frontend` (bare names, no `#` prefix)
- `created_by` (text, FK → agents.id)
- `created_at` (integer) — unix timestamp ms

**`messages`** — append-only message log
- `id` (integer, PK, autoincrement)
- `channel_id` (integer, FK → channels.id)
- `agent_id` (text, FK → agents.id)
- `content` (text)
- `created_at` (integer) — unix timestamp ms

**`cursors`** — tracks last-read position per agent per channel
- `agent_id` (text, FK → agents.id)
- `channel_id` (integer, FK → channels.id)
- `last_read_message_id` (integer) — highest message ID this agent has seen
- PK: (agent_id, channel_id)

### Indexes

- `messages(channel_id, id, agent_id)` — covers cursor-based reads with self-exclusion filter

### Design Choices

- **Autoincrement IDs** guarantee total message ordering within the DB
- **No deletes or edits** — append-only log, simple and auditable
- **Timestamps in unix ms** — consistent, no timezone ambiguity
- **Agent IDs are project repo names** — e.g., `octo-santa`, not generic `backend-agent`

## Schema Migration

Flyway-like migration-on-startup with exclusive locking:

1. Process starts, acquires `BEGIN EXCLUSIVE` transaction — locks entire DB for writing
2. Reads `PRAGMA user_version` — if already at target version, commit and proceed
3. If behind, runs migrations sequentially within the same exclusive transaction
4. Updates `PRAGMA user_version`, commits — lock released
5. Other processes blocked on the exclusive lock then acquire it, see version is current, skip

Migrations are defined as an ordered array of `{ version, up }` objects in `migrations.ts`, where `up` is a SQL string (multi-statement strings are supported by `bun:sqlite`). Each migration has a globally unique version number across all modules (e.g., messaging uses 1-99, brain uses 100-199). `runMigrations` validates that no duplicate versions exist before executing. Schema version is tracked via SQLite's built-in `PRAGMA user_version`. No down migrations — fix forward if a migration is bad.

## MCP Tools

Seven tools exposed to agents:

### Identity & Channels

**`register(agent_id)`**
- Self-register an agent. Idempotent (`INSERT OR IGNORE`).
- Called implicitly by other tools if the agent doesn't exist.

**`create_channel(name)`**
- Create a named channel. Idempotent (`INSERT OR IGNORE`).
- Returns channel info whether newly created or already existed.

**`list_channels()`**
- List all channels.

### Messaging

**`send_message(agent_id, channel, content)`**
- Post a message to a channel. Auto-registers agent and auto-creates channel if needed.
- The sender will not see their own messages when reading (filtered at read time, not via cursor advancement).
- Returns message ID on success, explicit error on failure.
- Internal retry with exponential backoff on SQLITE_BUSY (in the core function, not just the MCP wrapper).

**`read_messages(agent_id, channel)`**
- Returns unread messages since agent's cursor in the specified channel.
- Advances cursor atomically in the same transaction (only when reading forward/unread messages).
- Optional parameters: `limit` (cap number of messages returned), `before_id` (query history before a specific message — does NOT advance cursor, as this is a history lookup).

### Presence

**`list_agents()`**
- List all known agents with `last_seen_at` timestamps.
- Gives agents awareness of who else is around.

**`list_members(channel_name)`**
- List members of a specific channel with an `active` flag (derived from PID liveness and `last_seen_at` freshness).
- Agent lifecycle and presence details (liveness tiers, PID staleness) are covered in the agent lifecycle spec (`2026-03-24-agent-lifecycle-and-membership.md`).

### Tool Namespacing

Tools are prefixed with `messaging_` to avoid collisions as future modules are added. The naming pattern is `<module>_<action>`. Final tool names: `messaging_register`, `messaging_send_message`, `messaging_read_messages`, `messaging_create_channel`, `messaging_list_channels`, `messaging_list_agents`, `messaging_list_members`.

### Design Choices

- **`agent_id` is a parameter bound as session state** — the agent identifies itself on every call. The first call with `agent_id` binds the session to that agent (one agent per stdio process). Subsequent calls with a different `agent_id` are rejected before any DB mutation. No auth beyond identity binding.
- **No `join_channel` concept** — any agent can read/write any channel. Cursor is created on first `read_messages`.
- **Implicit registration** — agents don't need to call `register` explicitly. Any tool call that carries `agent_id` auto-registers.
- **Presence updates** — `last_seen_at` is updated only on tools that carry `agent_id` (register, create_channel, send_message, read_messages). List tools don't carry identity and don't update presence.

## MCP Server Configuration

Agents connect by adding octo-santa to their Claude Code MCP config:

```json
{
  "mcpServers": {
    "octo-santa": {
      "command": "bun",
      "args": ["run", "/path/to/octo-santa/src/server.ts"],
      "env": {
        "OCTO_SANTA_DB": "/Users/you/.octo-santa/messages.db"
      }
    }
  }
}
```

- **Single shared DB path** — all agents point to the same SQLite file. This is what enables cross-project communication.
- **No server to start** — Claude Code spawns the MCP process via stdio automatically.
- **DB in home directory** — project-independent, one machine, one message store.
- **`OCTO_SANTA_DB` is optional** — defaults to `$HOME/.octo-santa/messages.db` if not set. Use an absolute path (not `~`) since env vars in JSON are not shell-expanded. The server expands a leading `~` to the home directory as a convenience.
- **First-run:** process auto-creates the DB file and runs migrations on startup. No init step.

## Project Structure

```
octo-santa/
├── src/
│   ├── server.ts              # MCP entry point + push lifecycle
│   ├── channel.ts             # Background polling + channel notifications
│   ├── db.ts                  # Shared SQLite connection, WAL, busy timeout
│   ├── migrations.ts          # All migrations, ordered across modules
│   ├── types.ts               # OctoModule interface
│   └── modules/
│       └── messaging/
│           ├── index.ts       # MCP tool registration
│           ├── tools.ts       # Core functions
│           └── types.ts       # Data types
├── tests/
│   ├── channel/               # Push polling tests
│   └── messaging/             # Messaging tool tests (incl. binding)
├── docs/
├── package.json
└── tsconfig.json
```

Each module implements the `OctoModule` interface:

```typescript
interface OctoModule {
  name: string;
  migrations: Migration[];
  registerTools: (
    server: McpServer,
    getDb: () => Database,
    onAgentId?: (agentId: string) => void
  ) => void;
}
```

The optional `onAgentId` callback lets the server bind agent identity on first tool call, triggering the background push polling loop. `server.ts` collects and registers all modules. Adding a module = add a folder, export the interface, import in `server.ts`.

## Testing Strategy

All tests run against real SQLite (temp files per test). No mocks.

### Test Categories

1. **Unit tests** — each tool function in isolation. Send a message, read it back, verify cursor advancement.

2. **Concurrency tests** — the critical category:
   - Multiple processes writing simultaneously (spawn child processes)
   - Migration race — multiple processes starting against an empty DB
   - Verify no messages lost under contention
   - Verify BUSY retry recovers

3. **Module integration tests** — realistic tool sequences:
   - Agent registers → creates channel → sends message → another agent reads
   - Cursor tracking across multiple read cycles
   - Idempotent operations (double-register, double-create-channel)

4. **Module interface tests** — verify each module exports the standard interface correctly.

5. **Binding enforcement tests** — verify agent identity binding rejects mismatched `agent_id` before any DB mutation.

6. **Channel push tests** — polling behavior, watermark tracking, coalescing, self-exclusion, quiescent shutdown.

**Test runner:** `bun test`.

## Future Considerations (Out of Scope)

- **Remote communication via MOS** — MOS can be added as a network layer on top for cross-machine messaging.
- **Second brain module** — pooled knowledge that agents can query, with auto-routing to notify humans or relevant agents.
- **Third-party integrations** — Jira, Gmail, etc. as additional modules.
- **Message reactions, threads** — richer messaging primitives, added via migrations when needed.

Note: Push notifications were implemented via Claude Code Channels — see the [channel push design spec](2026-03-22-channel-push-design.md).
