# Build and Distribution

## Entry Points

octo-santa has two independent entry points serving different audiences:

| Entry point | Audience | Transport | Key dependencies |
|-------------|----------|-----------|-----------------|
| `src/server.ts` | Agents (MCP clients) | MCP stdio | `@modelcontextprotocol/sdk`, `src/channel.ts` |
| `src/repl.ts` | Humans (terminal) | stdin/stdout | `node:readline` |

Both import the shared core via `src/bootstrap.ts` (DB setup with module-derived
migrations) and `src/modules/messaging/tools.ts`. The shared core also includes
`src/db.ts` and `src/migrations.ts`. Entry points must never import from each other.

## Bundle Targets

```bash
bun build src/server.ts --outdir dist/agent   # agent-facing artifact
bun build src/repl.ts   --outdir dist/human   # human-facing CLI
```

Each bundle tree-shakes to include only its transport + the shared core:

- **Agent bundle** includes MCP SDK and channel push logic, excludes readline/CLI.
- **Human bundle** includes readline and CLI arg parsing, excludes MCP SDK.

## Invariant

`src/server.ts` and `src/repl.ts` are strict peers. They share the messaging core
via imports but have zero cross-dependencies. Any change that introduces an import
from one entry point to the other breaks the separate-bundle guarantee.
