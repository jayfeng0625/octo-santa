# Build and Distribution

## Entry Points

octo-santa has two independent entry points serving different audiences:

| Entry point | Audience | Transport | Key dependencies |
|-------------|----------|-----------|-----------------|
| `src/mcp.ts` | Agents (MCP clients) | MCP stdio | `@modelcontextprotocol/sdk`, `src/channel.ts` |
| `src/repl.ts` | Humans (terminal) | stdin/stdout | `node:readline` |

Both import the shared core via `src/bootstrap.ts` (DB setup with module-derived
migrations) and `src/modules/messaging/tools.ts`. The shared core also includes
`src/db.ts` and `src/migrations.ts`. Entry points must never import from each other.

## Build Targets

Different build strategies per entry point:

- **MCP**: bundled JS (lightweight, requires Bun at destination — which Claude Code
  already provides). Invoked via `bun dist/mcp.js`.
- **REPL**: compiled standalone binary (embeds Bun runtime, zero dependencies).
  Distributed to humans who may not have the repo or Bun installed.

```bash
bun run build           # both → dist/<version>/, symlinks dist/latest
bun run build:mcp       # MCP only
bun run build:repl      # REPL only
```

Output structure:

```
dist/
  0.3.0/
    mcp.js          # MCP bundle (~1MB, needs Bun)
    ocr             # REPL binary (~59MB, standalone)
  latest -> 0.3.0   # symlink, always points to current version
```

| Artifact | Source | Strategy | Size | Requires Bun |
|----------|--------|----------|------|-------------|
| `dist/<ver>/mcp.js` | `src/mcp.ts` | `bun build --target bun` | ~1MB | Yes |
| `dist/<ver>/ocr` | `src/repl.ts` | `bun build --compile` | ~59MB | No |

Version is read from `package.json`. The `dist/latest` symlink is updated on
every build so downstream references don't need updating on version bumps.

## .mcp.json

Point to `dist/latest/mcp.js` — the symlink tracks the current version:

```json
{
  "mcpServers": {
    "octo-santa": {
      "command": "bun",
      "args": ["run", "/path/to/dist/latest/mcp.js"]
    }
  }
}
```

Or run from source during development:

```json
{
  "mcpServers": {
    "octo-santa": {
      "command": "bun",
      "args": ["run", "/path/to/src/mcp.ts"]
    }
  }
}
```

## Invariant

`src/mcp.ts` and `src/repl.ts` are strict peers. They share the messaging core
via imports but have zero cross-dependencies. Any change that introduces an import
from one entry point to the other breaks the separate-bundle guarantee.
