## Runtime

Use Bun, not Node.js. `bun <file>`, `bun test`, `bun install`, `bunx`.

Bun auto-loads `.env` — don't use dotenv.

## Architecture

Hexagonal architecture (ports and adapters). See `docs/architecture.md` for full details.

```
src/
  core/           ← Domain logic + port interfaces. No infrastructure imports.
  storage/        ← Storage adapters (SQLite, filesystem brain store)
  transports/     ← Transport adapters (MCP stdio, REPL)
  notifications/  ← Notification adapters (dispatch + cross-process poller)
  main.ts         ← Composition root — wires everything together
```

**Key rules:**
- `src/core/` must NEVER import from `src/storage/`, `src/transports/`, or `src/notifications/`.
- `src/core/` must NEVER import `bun:sqlite` or `@modelcontextprotocol/*`.
- Adapters depend on core (port interfaces). Core depends on nothing external.
- Cross-adapter imports are forbidden (storage doesn't know about transports, etc.).
- Ports in `src/core/ports.ts` must serve core's needs, not adapter capabilities.

## Deployment Model

Each agent runs as its own OS process (MCP subprocess). There is no shared memory.

- **SQLite is the only cross-process bridge.** No IPC, no named pipes. If two processes
  need to communicate, it goes through the shared database.
- **Cross-process delivery requires polling.** Event-driven dispatch only works in-process.
  Don't design notification/delivery mechanisms that assume sender and receiver share memory.
- **Push is currently best-effort; adapters own push reliability.** Core dispatches push
  statelessly. As transports mature (MCP 2.0, message queues), adapter-level push reliability
  improves without core changes. Pull (`read_messages` / future `messaging_listen`) is always
  available as fallback. Messages are never lost — SQLite persistence is the invariant.
- **Always verify cross-process.** Any design touching notification, delivery, or agent-to-agent
  communication must work when sender and receiver are in different processes.

## APIs

- `bun:sqlite` for SQLite — only in `src/storage/sqlite/`. Don't use `better-sqlite3`.
- `@modelcontextprotocol/sdk` for MCP — only in `src/transports/mcp-stdio/`.

## SQLite Concurrency

Reference specs: `docs/specs/2026-03-21-messaging-module-design.md` (concurrency section),
`docs/specs/2026-04-03-sqlite-concurrency-at-scale.md` (design rules).

- Use `db.query()` for all queries — it caches compiled prepared statements by SQL string.
  Never use `db.prepare()` unless generating one-off dynamic SQL you don't want cached.
  See: https://bun.sh/docs/runtime/sqlite#query
- All write transactions MUST use `.immediate()` or `.exclusive()` — never bare `doTx()`.
- All writes MUST be wrapped in `withRetrySync()` from `src/storage/sqlite/db.ts`.
- Keep write transactions short — no async work, no network calls inside.
- Reads are free in WAL mode — no retry needed, no transaction needed.
- One DB connection per process. Never open a second connection in the same process.

## Testing

```bash
bun test              # all tests
bunx tsc --noEmit     # typecheck
```

## Development Process

Design specs and implementation plans are managed through the superpowers workflow.

### Specs (`docs/specs/`)

Design specifications. Always committed to git.

Remediation specs go in `docs/specs/remediation/` — always gitignored.

### Plans (`docs/plans/`)

Implementation plans. Always gitignored — plans are ephemeral working documents.

Remediation plans go in `docs/plans/remediation/` — always gitignored.
