## Monorepo Layout

This is a Bun-workspaces monorepo (`workspaces: ["packages/*"]`).

- `packages/octo-santa` — the agent messaging system (local-first messaging over MCP).
- `packages/*` — future consumer apps/bridges (e.g. issue-tracker bridges).

Run `bun install`, `bun test`, and `bunx tsc --noEmit` from the repo root.

## Runtime

Use Bun, not Node.js. `bun <file>`, `bun test`, `bun install`, `bunx`.

Bun auto-loads `.env` — don't use dotenv.

## Architecture

Hexagonal architecture (ports and adapters). See `packages/octo-santa/docs/architecture.md` for full details.

```
packages/octo-santa/src/
  core/           ← Domain logic + port interfaces. No infrastructure imports.
  storage/        ← Storage adapter (SQLite)
  transports/     ← Transport adapter (MCP stdio)
  notifications/  ← Notification adapter (SQLite watcher → MCP channel push)
  main.ts         ← Composition root — wires everything together
```

**Key rules:**
- `packages/octo-santa/src/core/` must NEVER import from `packages/octo-santa/src/storage/`, `packages/octo-santa/src/transports/`, or `packages/octo-santa/src/notifications/`.
- `packages/octo-santa/src/core/` must NEVER import `bun:sqlite` or `@modelcontextprotocol/*`.
- Adapters depend on core (port interfaces). Core depends on nothing external.
- Cross-adapter imports are forbidden (storage doesn't know about transports, etc.).
- Ports in `packages/octo-santa/src/core/ports.ts` must serve core's needs, not adapter capabilities.

## Deployment Model

Each agent runs as its own OS process (MCP subprocess). There is no shared memory.

- **SQLite is the only cross-process bridge.** No IPC, no named pipes. If two processes
  need to communicate, it goes through the shared database.
- **Cross-process delivery requires watching SQLite.** Don't design notification/delivery
  mechanisms that assume sender and receiver share memory.
- **Push is MCP channel notifications; poll is reading SQLite.** Each agent's server
  process watches the shared database and pushes matching messages as
  `notifications/claude/channel` MCP notifications. Push is best-effort;
  `messaging_read_messages` is always available as poll fallback. Messages are never
  lost — SQLite persistence is the invariant.
- **Always verify cross-process.** Any design touching notification, delivery, or agent-to-agent
  communication must work when sender and receiver are in different processes.

## APIs

- `bun:sqlite` for SQLite — only in `packages/octo-santa/src/storage/sqlite/`. Don't use `better-sqlite3`.
- `@modelcontextprotocol/server` (SDK v2) for MCP — only in `packages/octo-santa/src/transports/mcp-stdio/`.

## SQLite Concurrency

Reference specs: `packages/octo-santa/docs/specs/2026-03-21-messaging-module-design.md` (concurrency section),
`packages/octo-santa/docs/specs/2026-04-03-sqlite-concurrency-at-scale.md` (design rules).

- Use `db.query()` for all queries — it caches compiled prepared statements by SQL string.
  Never use `db.prepare()` unless generating one-off dynamic SQL you don't want cached.
  See: https://bun.sh/docs/runtime/sqlite#query
- All write transactions MUST use `.immediate()` or `.exclusive()` — never bare `doTx()`.
- All writes MUST be wrapped in `withRetrySync()` from `packages/octo-santa/src/storage/sqlite/db.ts`.
- Keep write transactions short — no async work, no network calls inside.
- Reads are free in WAL mode — no retry needed, no transaction needed.
- One DB connection per process. Never open a second connection in the same process.

## Testing

```bash
bun test              # all tests (from the repo root)
bunx tsc --noEmit     # typecheck (from the repo root)
```

## Development Process

Design specs and implementation plans are managed through the superpowers workflow.

### Specs (`packages/octo-santa/docs/specs/`)

Design specifications. Always committed to git.

Remediation specs go in `packages/octo-santa/docs/specs/remediation/` — always gitignored.

### Plans (`packages/octo-santa/docs/plans/`)

Implementation plans. Always gitignored — plans are ephemeral working documents.

Remediation plans go in `packages/octo-santa/docs/plans/remediation/` — always gitignored.
