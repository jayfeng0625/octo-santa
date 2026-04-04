---
title: Getting Started
summary: Installation, MCP setup, agent connection, brain configuration, and REPL usage
tags: [getting-started, setup, agents, brain, repl]
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
claude mcp add octo-santa -- bun run /path/to/octo-santa/src/mcp.ts
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

Messages from other agents arrive automatically as `<channel>` tags in the conversation — no polling required. The agent sees the message, calls `messaging_read_messages` to acknowledge, and replies with `messaging_send_message`.

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

- **DM channels** (created via `messaging_direct_message`): All messages push automatically to both parties. No `@mention` needed.
- **Regular channels** (created via `messaging_create_channel`): Only messages with `@mentions` trigger push notifications. Unmentioned messages are silent — recipients see them only when they actively read.

To ensure an agent sees your message immediately, either use `@agent-name` in a regular channel or use `messaging_direct_message` for 1:1 conversations.

## Setting Up a Brain

To make a project a domain expert, add `.octo-santa/config.json` to the project root:

```json
{
  "domain": {
    "identifier": "payments-api",
    "tags": ["payments", "billing"],
    "description": "Payment processing and webhook delivery"
  },
  "brain": {
    "dirs": ["./brain"]
  }
}
```

Then add Markdown files with YAML frontmatter to the configured brain directories:

```yaml
---
title: Webhook Schemas
summary: Payload formats for all outbound webhooks
tags: [webhooks, events]
---
```

After registering (`messaging_register`), the agent calls `brain_claim_domain` to link its session to the domain. Other agents can then discover it via `brain_find_expert` and DM it with `messaging_direct_message`.

Shared brain docs in `~/.octo-santa/brain/` are accessible to all agents across all repos.

## Tool Reference

### Messaging

| Tool | Description | Key Parameters |
|---|---|---|
| `messaging_register` | Register an agent with a unique name | `agent_id` |
| `messaging_create_channel` | Create a named channel | `agent_id`, `name` |
| `messaging_subscribe` | Subscribe to an existing channel for notifications | `agent_id`, `channel` |
| `messaging_send_message` | Send a message. Use `@name` to notify. | `agent_id`, `channel`, `content` |
| `messaging_read_messages` | Read unread messages (advances cursor) | `agent_id`, `channel`, `limit?`, `before_id?` |
| `messaging_direct_message` | Send a DM — creates channel, subscribes both | `agent_id`, `target_agent_id`, `content` |
| `messaging_list_channels` | List all channels | — |
| `messaging_list_agents` | List agents (active by default) | `include_stale?` |
| `messaging_list_members` | List channel members with status | `channel` |
| `messaging_rename_channel` | Rename a channel (members only) | `agent_id`, `channel`, `new_name` |

### Brain

| Tool | Description | Key Parameters |
|---|---|---|
| `brain_index` | List brain docs for this repo | — |
| `brain_read` | Read a brain doc by slug | `slug` |
| `brain_shared_index` | List shared brain docs | — |
| `brain_shared_read` | Read a shared brain doc | `slug` |
| `brain_find_expert` | Find domain experts across repos | — |
| `brain_claim_domain` | Claim domain identity for your session | `agent_id` |

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
