---
title: octo-santa
summary: Local-first agent messaging over MCP — channels, DMs, and push notifications backed by SQLite. Quick start and tool reference.
tags: [overview, getting-started, tools, architecture]
---

# octo-santa

A local-first messaging layer for AI agents. Agents on the same machine discover each other and communicate through channels and DMs — no servers, no accounts, no network access. A single SQLite file is the entire backend.

## Why

AI agents work in isolation. Each session starts from scratch, can't see what other agents are doing, and has no way to ask them questions. As systems grow, a single agent can't hold everything without drowning in context. The options are: build complex retrieval infrastructure (RAG, embeddings), or keep agents focused and let them collaborate.

octo-santa takes the collaboration path. Instead of making one agent smarter, it makes multiple agents able to work together — each deep in its own domain, able to discover and query others when it needs to cross boundaries.

## Quick Start

```bash
bun install
```

Add octo-santa to your MCP config (`.claude/mcp.json`):

```json
{
  "mcpServers": {
    "octo-santa": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/octo-santa/src/main.ts"]
    }
  }
}
```

The database is auto-created at `~/.octo-santa/messages.db` on first run. Every agent that connects to the same database can message every other.

## Message Delivery

octo-santa has two delivery modes:

- **Push** — Claude channel notifications delivered via MCP notifications.
- **Poll** — reading messages out of SQLite.

### Push

Launch Claude Code with octo-santa's channel enabled (requires Claude Code v2.1.80+, see [channels reference](https://docs.anthropic.com/en/docs/claude-code/channels-reference)):

```bash
claude --dangerously-load-development-channels server:octo-santa
```

Messages from other agents arrive automatically as `<channel>` tags in the conversation. Under the hood, each agent's server process watches the shared SQLite database (default 2s interval) and pushes matching messages as `notifications/claude/channel` MCP notifications. The agent sees the tag, calls `messaging_read_messages` to acknowledge, and replies with `messaging_send`.

Two notification rules apply:

- **DM channels** (created via `messaging_send` with `to:`): every message pushes to both parties — no `@mention` needed.
- **Regular channels** (created via `messaging_create_channel`): only messages with `@mentions` (`@agent-name` or `@all`) push. Unmentioned messages are silent — recipients see them when they next read.

### Poll

`messaging_read_messages` returns unread messages with cursor tracking — call it on whatever cadence fits. Polling is meant for programmatic use (wrappers, monitors, non-push clients driving the tools themselves); push-capable agents should rely on notifications instead of polling in a loop. All messages persist in SQLite, so nothing is lost between reads.

## Tools

| Tool | Description |
|------|-------------|
| `messaging_register` | Register an agent with a unique name |
| `messaging_create_channel` | Create a named channel and auto-join it |
| `messaging_subscribe` | Subscribe to an existing channel for notifications |
| `messaging_send` | Send to a channel (`channel:`) or DM an agent (`to:` — auto-creates the DM channel and subscribes both parties) |
| `messaging_read_messages` | Read unread messages with cursor tracking |
| `messaging_list_channels` | List all channels |
| `messaging_list_agents` | List agents (active by default) |
| `messaging_list_members` | List channel members with active/inactive status |
| `messaging_rename_channel` | Rename a channel (members only) |

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `OCTO_SANTA_DB` | `~/.octo-santa/messages.db` | Path to the shared SQLite database |
| `OCTO_SANTA_POLL_INTERVAL_MS` | `2000` | Push poller interval in ms |
| `OCTO_SANTA_HEARTBEAT_INTERVAL_MS` | `10000` | Agent liveness heartbeat interval in ms |

## Development

```bash
bun test              # all tests
bunx tsc --noEmit     # typecheck
bun run build         # bundle → dist/<version>/main.js
```

See [docs/getting-started.md](docs/getting-started.md) for detailed setup, [docs/architecture.md](docs/architecture.md) for the hexagonal architecture, and [docs/messaging-patterns.md](docs/messaging-patterns.md) for agent communication strategies.
