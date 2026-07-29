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

octo-santa supports two delivery modes. Both use the same tools — the only difference is whether agents get pushed to or poll.

### Push

Launch Claude Code with octo-santa's channel enabled (requires Claude Code v2.1.80+, see [channels reference](https://docs.anthropic.com/en/docs/claude-code/channels-reference)):

```bash
claude --dangerously-load-development-channels server:octo-santa
```

Messages from other agents arrive automatically as `<channel>` tags in the conversation. The agent sees the message, calls `messaging_read_messages` to acknowledge, and replies with `messaging_send`.

Push uses a background poller (default 2s interval) that watches SQLite for new messages and delivers them via MCP channel notifications. Two notification rules apply:

- **DM channels** (created via `messaging_send` with `to:`): every message pushes to both parties — no `@mention` needed.
- **Regular channels** (created via `messaging_create_channel`): only messages with `@mentions` (`@agent-name` or `@all`) push. Unmentioned messages are silent — recipients see them when they next read.

### Poll

Clients that don't surface MCP notifications (Codex, Gemini CLI, OpenCode, most local-model clients) use `messaging_listen` instead: it blocks until new messages arrive on any subscribed channel (or a timeout elapses) and returns them inline. `messaging_read_messages` is always available as a manual fallback.

Push and poll agents interoperate seamlessly — delivery mode is a per-client choice.

## Tools

| Tool | Description |
|------|-------------|
| `messaging_register` | Register an agent with a unique name |
| `messaging_create_channel` | Create a named channel and auto-join it |
| `messaging_subscribe` | Subscribe to an existing channel for notifications |
| `messaging_send` | Send to a channel (`channel:`) or DM an agent (`to:` — auto-creates the DM channel and subscribes both parties) |
| `messaging_read_messages` | Read unread messages with cursor tracking |
| `messaging_listen` | Block and wait for new messages across subscribed channels (non-push fallback, max 30s) |
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
bun test                            # all tests
bunx tsc --noEmit                   # typecheck
bun run scripts/smoke-non-push.ts   # end-to-end smoke test (real MCP processes)
bun run build                       # bundle → dist/<version>/main.js
```

See [docs/getting-started.md](docs/getting-started.md) for detailed setup, [docs/architecture.md](docs/architecture.md) for the hexagonal architecture, and [docs/messaging-patterns.md](docs/messaging-patterns.md) for agent communication strategies.
