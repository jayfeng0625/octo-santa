# Admin Plane: Typehead-Described SQL Access over a Separate MCP Connection

**Date:** 2026-08-01
**Status:** Implemented
**Builds on:** 2026-04-04-hexagonal-architecture-design.md, 2026-07-30-structured-tool-output.md

## What

An elevated access plane for approved 1st/3rd-party apps that integrate with
octo-santa programmatically, without going through the chat-style messaging
tools. It is served on a **separate MCP connection** (its own entrypoint,
`src/admin.ts`, its own server identity `octo-santa-admin`) and exposes exactly
two generic tools, code-mode/PTC style:

- `admin_search` — read-only query in the storage provider's dialect
- `admin_execute` — one mutating statement, applied atomically

How to *use* those two tools is not baked into core. The active storage
provider authors a **typehead** — a complete TypeScript `.d.ts` declaration
file — describing its dialect, every table's row shape, and the invariants a
direct writer must uphold. The transport serves it as MCP resource
`octo-santa://admin/typehead.d.ts`. Clients read it once and then have a typed,
compile-time contract for everything the two generic tools can do.

## Why

Two driving use cases:

1. **External agent loops.** A bridge process listens for issue-tracker
   webhooks (Linear, Notion, Jira). On a change event it decides which channels
   and agents to target and pushes directly to the database. Because SQLite is
   octo-santa's only cross-process bridge and every agent process watches the
   `messages` table, an `INSERT` with a `mentions` JSON array **is** a push
   delivery — no other signal exists or is needed.
2. **OLAP-style analytics.** Aggregation queries over message history, straight
   from the database, without consuming any agent's unread cursor.

Both need more than the messaging tools allow (membership checks, registration,
cursor semantics) and less than a bespoke tool per operation. Two generic
tools + a machine-readable typehead give infinite extensibility with a fixed
tool surface.

## Architecture

Hexagonal placement — core stays dialect-blind:

```
core/admin/types.ts        AdminValue, AdminRow, results, AdminInterfaceDescription
core/ports.ts              AdminStoragePort { describe, search, execute }
core/admin/service.ts      AdminService — validation, row cap, delegation
storage/sqlite/
  admin-typehead.ts        SQLITE_ADMIN_TYPEHEAD — the provider-authored .d.ts text
  admin-gateway.ts         SqliteAdminGateway implements AdminStoragePort
transports/mcp-admin-stdio/
  adapter.ts               admin_search + admin_execute tools, typehead resource
  schemas.ts               wire schemas (satisfies-checked against core types)
admin.ts                   composition root for the admin connection
```

- **Core** (`AdminService`, `AdminStoragePort`): queries and statements are
  opaque strings; core validates non-emptiness, caps search results
  (`maxRows`, default 10k, `OCTO_SANTA_ADMIN_MAX_ROWS`), and hands the
  provider's `AdminInterfaceDescription` (provider, dialect, typehead text)
  through untouched. The port is shaped by core's need — "elevated generic
  access + self-description" — not by SQLite capabilities.
- **Storage** (`SqliteAdminGateway`): owns dialect meaning and enforcement.
  `search` runs under `PRAGMA query_only = ON` (toggled around the
  synchronous call — bun:sqlite's sync execution means nothing can interleave
  inside the window), so any mutation attempt fails at step time. `execute`
  wraps one statement in an `.immediate()` transaction with `withRetrySync`.
  Both use `db.prepare()` (not `db.query()`) because admin SQL is one-off
  dynamic text that must not pollute the statement cache; statements are
  finalized after use. Row cells are normalized to JSON scalars (BLOB →
  base64, bigint → number).
- **Transport** (`mcp-admin-stdio`): a second stdio adapter, structurally like
  the messaging one but stateless — no agent binding, no poller, no heartbeat.
  Tool results follow the structured-output contract (top-level objects,
  `text === JSON.stringify(structuredContent)`). `admin_execute` carries
  `destructiveHint: true` — arbitrary statements can update or delete.
- **Typehead as a resource, not a tool.** The tool surface staying at exactly
  search + execute is the point; static reference material belongs on the
  resource surface. The typehead is provider-authored: swapping in a Postgres
  storage backend means shipping a Postgres gateway with its own typehead —
  core, transport, and the two-tool contract don't change.

## Separate connection, elevated trust

The admin plane is a different MCP server (`octo-santa-admin`) with a different
entrypoint. "Approved" is enforced the local-first way: only whoever configures
the MCP client to launch `src/admin.ts` (or `dist/<version>/admin.js`) gets the
plane — same trust boundary as file access to `messages.db` itself, with no
accounts or network exposure added. The messaging connection never gains these
tools; agent-facing sessions cannot reach the elevated surface.

## Invariants direct writers must uphold (documented in the typehead)

- `messages.agent_id` and `channels.created_by` are FKs to `agents.id`
  (`foreign_keys = ON`): register a sender row first (`INSERT OR IGNORE`) or
  send as the seeded `_system` agent.
- Push targeting reads the `mentions` column (`'["name"]'`, `'["*"]'`,
  `'[]'` = silent), not message content.
- A `cursors` row is what makes an agent a channel member.
- Message ids are monotonic; timestamps are Unix epoch ms; `schema_migrations`
  is off-limits.

## Testing

- `tests/hex/core/admin-service.test.ts` — dialect-agnostic delegation,
  validation, row cap (fake port).
- `tests/hex/storage/admin-gateway.test.ts` — read-only enforcement, atomic
  execute, FK enforcement, blob normalization, and a **typehead drift guard**:
  every column `pragma_table_info` reports must appear in the `.d.ts`.
- `tests/hex/transports/admin-tool-metadata.test.ts` — exactly two tools,
  annotations, structured-output contract, typehead resource, <2KB
  instructions.
- `tests/admin/external-integration.test.ts` — end-to-end use cases: an
  issue-tracker bridge's insert is seen by `messaging_read_messages` and the
  notification watcher queries; OLAP aggregation leaves cursors untouched.
