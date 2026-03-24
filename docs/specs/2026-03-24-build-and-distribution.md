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
bun run build           # both
bun run build:mcp       # agent-facing: dist/mcp.js
bun run build:repl      # human-facing: dist/ocr
```

| Artifact | Source | Strategy | Size | Requires Bun |
|----------|--------|----------|------|-------------|
| `dist/mcp.js` | `src/mcp.ts` | `bun build --target bun` | ~few hundred KB | Yes |
| `dist/ocr` | `src/repl.ts` | `bun build --compile` | ~59MB | No |

## .mcp.json

After building, `.mcp.json` can reference the bundled artifact:

```json
{
  "mcpServers": {
    "octo-santa": {
      "command": "bun",
      "args": ["run", "/path/to/dist/mcp.js"]
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
