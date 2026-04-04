## Runtime

Use Bun, not Node.js. `bun <file>`, `bun test`, `bun install`, `bunx`.

Bun auto-loads `.env` — don't use dotenv.

## APIs

- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `@modelcontextprotocol/sdk` for MCP server/transport.

## SQLite Concurrency

Reference specs: `docs/specs/2026-03-21-messaging-module-design.md` (concurrency section),
`docs/specs/2026-04-03-sqlite-concurrency-at-scale.md` (design rules).

- Use `db.query()` for all queries — it caches compiled prepared statements by SQL string.
  Never use `db.prepare()` unless generating one-off dynamic SQL you don't want cached.
  See: https://bun.sh/docs/runtime/sqlite#query
- All write transactions MUST use `.immediate()` or `.exclusive()` — never bare `doTx()`.
- All writes MUST be wrapped in `withRetrySync()` from `src/db.ts`.
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
