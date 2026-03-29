## Runtime

Use Bun, not Node.js. `bun <file>`, `bun test`, `bun install`, `bunx`.

Bun auto-loads `.env` — don't use dotenv.

## APIs

- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `@modelcontextprotocol/sdk` for MCP server/transport.
- `ink` and `react` for the REPL terminal UI (`src/repl/`). Uses `ink-testing-library` for component tests.

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
