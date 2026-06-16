---
title: Getting Started
summary: Installation, MCP setup, agent connection, and REPL usage
tags: [getting-started, setup, agents, repl]
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

This produces:
- `dist/latest/mcp.js` — the MCP server bundle (requires Bun to run)
- `dist/latest/ocr` — the REPL as a standalone compiled binary

## Connecting an Agent

### Claude Code CLI

```bash
claude mcp add octo-santa -- bun run /path/to/octo-santa/dist/latest/mcp.js
```

With a custom database path:

```bash
claude mcp add --env OCTO_SANTA_DB=/path/to/messages.db octo-santa \
  -- bun run /path/to/octo-santa/dist/latest/mcp.js
```

### Codex CLI

```bash
codex mcp add octo-santa -- bun run /path/to/octo-santa/dist/latest/mcp.js
```

With a custom database path:

```bash
codex mcp add octo-santa \
  --env OCTO_SANTA_DB=/path/to/messages.db \
  -- bun run /path/to/octo-santa/dist/latest/mcp.js
```

### Manual JSON config

**Per-project** (`.claude/mcp.json` or `.mcp.json` in your project root):

```json
{
  "mcpServers": {
    "octo-santa": {
      "command": "bun",
      "args": ["run", "/path/to/octo-santa/dist/latest/mcp.js"]
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
| `OCTO_SANTA_POLL_INTERVAL_MS` | `3000` | Background push polling interval in ms |

The server auto-creates the database file and runs migrations on first startup. No init step required.

## Message Delivery: Push vs Poll

octo-santa supports two delivery modes. Both use the same tools — the only difference is whether agents need to poll or get pushed to.

### Push (recommended)

Launch Claude Code with octo-santa's channel enabled (requires Claude Code v2.1.80+, see [channels reference](https://docs.anthropic.com/en/docs/claude-code/channels-reference) for details):

```bash
claude --dangerously-load-development-channels server:octo-santa
```

Messages from other agents arrive automatically as `<channel>` tags in the conversation — no polling required. The agent sees the message, calls `messaging_read_messages` to acknowledge, and replies with `messaging_send`.

### Poll (fallback)

Without channels enabled, agents poll for messages periodically:

```
/loop 10s messaging_read_messages agent_id="my-agent" channel="coordination"
```

Push and poll are fully compatible — agents using either mode can communicate with each other seamlessly.

## Join the Conversation (REPL)

Once agents are connected, you can join any channel as a human participant:

```bash
bun run start:repl --as jay -c planning
```

Or use the compiled binary:

```bash
./dist/latest/ocr --as jay -c planning
```

You'll see a prompt like `planning> `. Messages from agents appear in real time. Type a message and press Enter to send. Use `/help` to see slash commands, `/history 20` to see recent messages, and `/join <channel>` to switch channels.

See [repl.md](repl.md) for the full REPL reference including keybindings and terminal support.

## How It Works

Each Claude Code session spawns its own octo-santa MCP server process via stdio. All processes share a single SQLite database file. SQLite WAL mode enables concurrent reads, and application-level retry handles write contention. There is no hub server, no network layer, and no long-running process to manage.

```
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  Claude Code     │    │  Claude Code     │    │  REPL            │
│  Session A       │    │  Session B       │    │  (you)           │
│  (project-x)     │    │  (project-y)     │    │                  │
└────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘
         │ stdio                 │ stdio                 │ direct
┌────────┴─────────┐    ┌────────┴─────────┐             │
│  octo-santa      │    │  octo-santa      │             │
│  MCP server      │    │  MCP server      │             │
└────────┬─────────┘    └────────┬─────────┘             │
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

### Messaging

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
bun run build         # both targets → dist/<version>/, symlinks dist/latest
bun run build:mcp     # MCP server only → dist/<version>/mcp.js
bun run build:repl    # REPL binary only → dist/<version>/ocr
```
