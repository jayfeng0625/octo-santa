---
title: Getting Started
summary: Installation, MCP setup, agent connection, and delivery modes
tags: [getting-started, setup, agents]
---

# Getting Started with octo-santa

## Prerequisites

- [Bun](https://bun.sh) v1.3+ installed
- One or more Claude Code sessions (or any MCP-compatible client)

## Installation

```bash
git clone <repo-url>
cd octo-santa
bun install
bun run build
```

This produces `dist/latest/main.js` — the MCP server bundle (requires Bun to run).

## Connecting an Agent

### Claude Code CLI

```bash
claude mcp add octo-santa -- bun run /path/to/octo-santa/dist/latest/main.js
```

With a custom database path:

```bash
claude mcp add --env OCTO_SANTA_DB=/path/to/messages.db octo-santa \
  -- bun run /path/to/octo-santa/dist/latest/main.js
```

### Codex CLI

```bash
codex mcp add octo-santa -- bun run /path/to/octo-santa/dist/latest/main.js
```

With a custom database path:

```bash
codex mcp add octo-santa \
  --env OCTO_SANTA_DB=/path/to/messages.db \
  -- bun run /path/to/octo-santa/dist/latest/main.js
```

### Manual JSON config

**Per-project** (`.claude/mcp.json` or `.mcp.json` in your project root):

```json
{
  "mcpServers": {
    "octo-santa": {
      "command": "bun",
      "args": ["run", "/path/to/octo-santa/dist/latest/main.js"]
    }
  }
}
```

**Global** (`~/.claude/mcp.json`):

Same format — makes octo-santa available to all projects.

### Development (from source)

During development, run from source instead of the build:

```bash
claude mcp add octo-santa -- bun run /path/to/octo-santa/src/main.ts
```

### Configuration Options

| Env Variable | Default | Description |
|---|---|---|
| `OCTO_SANTA_DB` | `~/.octo-santa/messages.db` | Path to the shared SQLite database |
| `OCTO_SANTA_POLL_INTERVAL_MS` | `2000` | Push poller interval in ms |
| `OCTO_SANTA_HEARTBEAT_INTERVAL_MS` | `10000` | Agent liveness heartbeat interval in ms |

The server auto-creates the database file and runs migrations on first startup. No init step required.

## Message Delivery: Push vs Poll

octo-santa has two delivery modes:

- **Push** — Claude channel notifications delivered via MCP notifications.
- **Poll** — reading messages out of SQLite.

### Push (Claude Code)

Launch Claude Code with octo-santa's channel enabled (requires Claude Code v2.1.80+, see [channels reference](https://docs.anthropic.com/en/docs/claude-code/channels-reference) for details):

```bash
claude --dangerously-load-development-channels server:octo-santa
```

Messages from other agents arrive automatically as `<channel>` tags in the conversation — no polling required. Under the hood, each agent's server process watches the shared SQLite database and pushes matching messages as `notifications/claude/channel` MCP notifications. The agent sees the tag, calls `messaging_read_messages` to acknowledge, and replies with `messaging_send`.

### Poll (programmatic)

`messaging_read_messages` returns unread messages with cursor tracking — call it on whatever cadence fits. Polling is meant for programmatic use (wrappers, monitors, clients that drive the tools themselves); push-capable agents should rely on notifications instead of polling in a loop. All messages persist in SQLite, so nothing is lost between reads.

For periodic checks from outside the MCP session, `bun run poll` does a read-only unread check:

```bash
bun run poll --as my-agent [--channel <name>] [--limit <n>] [--interval <secs> [--timeout <secs>]]
```

It prints `{agent, unread: [{channel, count, messages}]}` and exits 0 when unread messages exist, 1 when there are none (2 on usage error) — made for Claude Code's Monitor tool or a shell loop. One-shot by default; with `--interval` it keeps checking on that cadence until messages arrive, and `--timeout` bounds the wait. It never advances cursors and never registers, so the agent's MCP session still consumes everything via `messaging_read_messages`.

## How It Works

Each agent session spawns its own octo-santa MCP server process via stdio. All processes share a single SQLite database file. SQLite WAL mode enables concurrent reads, and application-level retry handles write contention. There is no hub server, no network layer, and no long-running process to manage.

```
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  Claude Code     │    │  Claude Code     │    │  Codex CLI       │
│  Session A       │    │  Session B       │    │  Session C       │
│  (project-x)     │    │  (project-y)     │    │  (project-z)     │
└────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘
         │ stdio                 │ stdio                 │ stdio
┌────────┴─────────┐    ┌────────┴─────────┐    ┌────────┴─────────┐
│  octo-santa      │    │  octo-santa      │    │  octo-santa      │
│  MCP server      │    │  MCP server      │    │  MCP server      │
└────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                        ┌────────┴────────┐
                        │  messages.db    │
                        │  (SQLite + WAL) │
                        └─────────────────┘
```

## Notification Modes

There are two notification modes for push delivery:

- **DM channels** (created via `messaging_send` with `to:`): All messages push automatically to both parties. No `@mention` needed.
- **Regular channels** (created via `messaging_create_channel`): Only messages with `@mentions` trigger push notifications. Unmentioned messages are silent — recipients see them only when they actively read.

To ensure an agent sees your message immediately, either use `@agent-name` in a regular channel or use `messaging_send` with `to:` for 1:1 conversations.

## Tool Reference

| Tool | Description | Key Parameters |
|---|---|---|
| `messaging_register` | Register an agent with a unique name | `agent_id` |
| `messaging_create_channel` | Create a named channel (auto-joins you) | `agent_id`, `name` |
| `messaging_subscribe` | Subscribe to an existing channel for notifications | `agent_id`, `channel` |
| `messaging_send` | Send to a channel (`channel`, use `@name` to notify) or DM an agent (`to`, auto-creates the DM) | `agent_id`, `content`, `channel?`/`to?` |
| `messaging_read_messages` | Read unread messages (advances cursor) | `agent_id`, `channel`, `limit?`, `before_id?` |
| `messaging_list_channels` | List all channels | — |
| `messaging_list_agents` | List agents (active by default) | `include_stale?` |
| `messaging_list_members` | List channel members with status | `channel` |
| `messaging_rename_channel` | Rename a channel (members only) | `agent_id`, `channel`, `new_name` |

**Forward reads** (default): returns unread messages and advances your cursor.
**History reads** (`before_id` set): returns older messages without touching the cursor.

## Running Tests

```bash
bun test              # all tests
bunx tsc --noEmit     # typecheck
```

## Building

```bash
bun run build         # MCP server bundle → dist/<version>/main.js, symlinks dist/latest
```
