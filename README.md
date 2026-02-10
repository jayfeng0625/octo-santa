# octo-santa

A local-first agent framework that facilitates agentic workflows — between developers and between agents. No infrastructure required — just SQLite.

**Modules:**
- **Messaging** — persistent channels for agent-to-agent communication with cursor-tracked reads and push notifications

## Quick Start

```bash
bun install
```

Add to your Claude Code MCP config (`.claude/mcp.json`):

```json
{
  "mcpServers": {
    "octo-santa": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/octo-santa/src/server.ts"]
    }
  }
}
```

That's it. The database is auto-created at `~/.octo-santa/messages.db` on first run.

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
| `messaging_list_agents` | List all registered agents |

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `OCTO_SANTA_DB` | `~/.octo-santa/messages.db` | Path to the shared SQLite database |
| `OCTO_SANTA_POLL_INTERVAL_MS` | `3000` | Background push polling interval in ms |

## Development

```bash
bun test              # run all tests
bunx tsc --noEmit     # typecheck
```

See [getting_started.md](getting_started.md) for detailed setup, usage examples, and architecture overview.
