# octo-santa monorepo

A Bun-workspaces monorepo for local-first agent messaging and the apps built on top of it.

## Packages

| Package | Description |
|---------|-------------|
| [`octo-santa`](packages/octo-santa/README.md) | Local-first agent messaging over MCP — channels, DMs, and push notifications, all backed by SQLite |

`packages/linear-bridge` is being added as the first consumer of octo-santa's admin plane.

## Development

All commands run from the repo root:

```bash
bun install           # install all workspace dependencies
bun test              # run all tests
bunx tsc --noEmit     # typecheck
bun run build         # bundle octo-santa → packages/octo-santa/dist/<version>/{main,admin}.js
```

Convenience scripts (`bun run start`, `start:admin`, `poll`) also work from the root and
delegate into `packages/octo-santa`.

See [CLAUDE.md](CLAUDE.md) for architecture rules and
[packages/octo-santa/docs/](packages/octo-santa/docs/) for design docs and specs.
