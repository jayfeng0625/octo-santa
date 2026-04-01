# octo-santa

A local-first agent framework that facilitates agentic workflows — between developers and between agents. No infrastructure required — just SQLite and Markdown files.

## Why

AI agents today work in isolation. Each session starts from scratch, can't see what other agents are doing, and has no way to ask them questions. In a small codebase this is fine — one agent can hold enough context. But as systems grow, a single agent can't hold everything without drowning in context. The options are: build complex retrieval infrastructure (RAG, embeddings), or keep agents focused and let them collaborate.

octo-santa takes the collaboration path. Instead of making one agent smarter, it makes multiple agents able to work together — each deep in its own domain, able to discover and query others when it needs to cross boundaries.

## Roadmap

**Shipped:**
- **Messaging** — persistent channels for agent-to-agent communication with cursor-tracked reads, push notifications, and mention-based targeting
- **REPL** — interactive chat terminal for humans to observe, participate in, and moderate agent conversations in real time

**Planned:**
- **Brain** — a knowledge layer that makes agents into domain experts. Each project declares its domain via config, agents get indexed access to curated docs, and a discovery mechanism (`brain_find_expert`) lets agents find the right expert to DM. Cross-domain knowledge flows through agent-to-agent conversation, not shared document stores.
- **Per-domain config** (`.octo-santa/config.json`) — projects declare their identity, domain expertise, and brain directories. The agent's role in the network is defined by the repo it lives in.
- **Plugin distribution** — repackage octo-santa as a Claude Code plugin for install via `/plugin install` instead of manual MCP config. Enables SessionStart hooks for automatic brain priming, plugin channels for message delivery, and marketplace distribution.

## Quick Start

```bash
bun install
```

**Connect agents** — add to your MCP config (`.claude/mcp.json`):

```json
{
  "mcpServers": {
    "octo-santa": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/octo-santa/src/mcp.ts"]
    }
  }
}
```

**Join the conversation** — open the REPL to watch and talk to your agents:

```bash
bun run start:repl --as jay -c planning
```

The database is auto-created at `~/.octo-santa/messages.db` on first run.

## Message Delivery

octo-santa supports two delivery modes. Both use the same tools — the only difference is whether agents need to poll or get pushed to.

### Push (recommended)

Launch Claude Code with octo-santa's channel enabled (requires Claude Code v2.1.80+, see [channels reference](https://docs.anthropic.com/en/docs/claude-code/channels-reference) for details):

```bash
claude --dangerously-load-development-channels server:octo-santa
```

Messages from other agents arrive automatically as `<channel>` tags in the conversation — no polling required. The agent sees the message, calls `messaging_read_messages` to acknowledge, and replies with `messaging_send_message`.

Push uses a background polling loop (default 3s interval) that watches SQLite for unread messages and sends them via MCP channel notifications. Configurable via `OCTO_SANTA_POLL_INTERVAL_MS`.

### Poll (fallback)

Without channels enabled, agents must call `messaging_read_messages` periodically to check for new messages. You can automate this with Claude Code's `/loop` command:

```
/loop 10s messaging_read_messages agent_id="my-agent" channel="coordination"
```

Push and poll are fully compatible — agents using either mode can communicate with each other seamlessly.

## Tools

| Tool | Description |
|------|-------------|
| `messaging_register` | Register an agent |
| `messaging_create_channel` | Create a named channel |
| `messaging_list_channels` | List all channels |
| `messaging_send_message` | Send a message to a channel |
| `messaging_read_messages` | Read unread messages with cursor tracking |
| `messaging_list_agents` | List all known agents |

## REPL

The REPL gives you a human seat at the table — join any channel, see messages as they arrive, send messages, and use slash commands to navigate.

```bash
bun run start:repl --as jay -c planning
```

Type messages and press Enter to send. Use `/help` to see available commands. See [repl.md](repl.md) for the full reference (keybindings, commands, terminal support).

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `OCTO_SANTA_DB` | `~/.octo-santa/messages.db` | Path to the shared SQLite database |
| `OCTO_SANTA_POLL_INTERVAL_MS` | `3000` | Background push polling interval in ms (MCP server) |

## Development

```bash
bun test              # run all tests
bunx tsc --noEmit     # typecheck
```

See [getting-started.md](getting-started.md) for detailed setup, [repl.md](repl.md) for the REPL reference, and [messaging-patterns.md](messaging-patterns.md) for agent read strategies.
