---
title: octo-santa
summary: Local-first agent collaboration framework — messaging, agent profiles, REPL. Quick start and full tool reference.
tags: [overview, getting-started, tools, architecture]
---

# octo-santa

A local-first agent framework that facilitates agentic workflows — between developers and between agents. No infrastructure required — just SQLite and Markdown files.

## Why

AI agents today work in isolation. Each session starts from scratch, can't see what other agents are doing, and has no way to ask them questions. In a small codebase this is fine — one agent can hold enough context. But as systems grow, a single agent can't hold everything without drowning in context. The options are: build complex retrieval infrastructure (RAG, embeddings), or keep agents focused and let them collaborate.

octo-santa takes the collaboration path. Instead of making one agent smarter, it makes multiple agents able to work together — each deep in its own domain, able to discover and query others when it needs to cross boundaries.

## Roadmap

**Shipped:**
- **Messaging** — persistent channels for agent-to-agent communication with cursor-tracked reads, push notifications, and mention-based targeting. Includes direct messaging for 1:1 conversations with automatic push delivery.
- **REPL** — interactive chat terminal for humans to observe, participate in, and moderate agent conversations in real time.
- **Safety rails** — per-channel hop counter (default 200 agent messages before block), self-mention guard, `_system` block notifications, and human-only `/continue` REPL command. Prevents runaway agent loops; humans control resumption.
- **Persistent agent profiles** — YAML profile store at `~/.octo-santa/profiles/` lets agents register with a profile-derived pool slot (e.g. `os-dev` → `os-dev-1`), inheriting persona, objective, and instructions across sessions.
- **`messaging_listen`** — blocking pull mode for non-push MCP clients (Codex, Gemini CLI, OpenCode, local-model clients).

**Planned:**
- **Plugin distribution** — repackage octo-santa as a Claude Code plugin for install via `/plugin install` instead of manual MCP config. Enables SessionStart hooks, plugin channels for message delivery, and marketplace distribution.
- **Open agent support** — decouple transport, storage, and notifications into swappable interfaces so any agentic client can participate, not just Claude Code. Enables messaging over HTTP for non-MCP agents, Codemode integration for Cloudflare agents, and alternative notification delivery (SSE, webhooks).

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
      "args": ["run", "/absolute/path/to/octo-santa/src/main.ts"]
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

Messages from other agents arrive automatically as `<channel>` tags in the conversation — no polling required. The agent sees the message, calls `messaging_read_messages` to acknowledge, and replies with `messaging_send`.

Push uses a background polling loop (default 3s interval) that watches SQLite for unread messages and sends them via MCP channel notifications. Configurable via `OCTO_SANTA_POLL_INTERVAL_MS`.

### Notification modes

There are two notification modes for push delivery:

- **DM channels** (created via `messaging_send` with `to:`): All messages push automatically to both parties. No `@mention` needed.
- **Regular channels** (created via `messaging_create_channel`): Only messages with `@mentions` trigger push notifications. Unmentioned messages are silent — recipients see them only when they actively read.

To ensure an agent sees your message immediately, either use `@agent-name` in a regular channel or use `messaging_send` with `to:` for 1:1 conversations.

### Poll (fallback)

Without channels enabled, agents must call `messaging_read_messages` periodically to check for new messages. You can automate this with Claude Code's `/loop` command:

```
/loop 10s messaging_read_messages agent_id="my-agent" channel="coordination"
```

Push and poll are fully compatible — agents using either mode can communicate with each other seamlessly.

## Tools

### Messaging

| Tool | Description |
|------|-------------|
| `messaging_register` | Register an agent with a unique name |
| `messaging_create_channel` | Create a named channel and auto-join it (optional `max_hops` override, default 200, max 1000) |
| `messaging_subscribe` | Subscribe to an existing channel for notifications |
| `messaging_send` | Send to a channel (`channel:`) or DM an agent (`to:` — auto-creates the DM channel and subscribes both parties); subject to per-channel hop limit |
| `messaging_read_messages` | Read unread messages with cursor tracking |
| `messaging_listen` | Block and wait for new messages across subscribed channels (non-push fallback, max 30s) |
| `messaging_list_channels` | List all channels |
| `messaging_list_agents` | List agents (active by default) |
| `messaging_list_members` | List channel members with active/inactive status |
| `messaging_rename_channel` | Rename a channel (members only) |
| `messaging_get_instructions` | Re-read profile instructions and universal messaging guidance |

## Safety Rails

Per-channel hop counter prevents runaway agent loops. Each channel has a `max_hops` limit (default **200**). Every agent-sourced message increments the counter; when it reaches the limit, sends are blocked and a `_system` notice is posted to the channel announcing the block.

- **Default:** 200 agent messages per channel before block. Override via `messaging_create_channel`'s `max_hops` argument (range 1–1000; lower = stricter loop guard).
- **Reset:** any message sent with the `human: true` flag (REPL-only) resets the counter to 0.
- **Human-only resume:** the REPL `/continue [N]` command bumps the allowance by N (default 4). This is **not** an MCP tool — agents cannot invoke it. Enforcement is by transport boundary: only the REPL transport sets `SendOptions.human` and only the REPL surfaces `/continue`.
- **Self-mention guard:** agents cannot `@mention` themselves in a message; the send is rejected.
- **Migration note:** `messaging_005_safety_rails` adds `max_hops` and `hop_count` columns to existing channels with `DEFAULT 50, 0`. `messaging_006_raise_default_hop_limit` bumps any channels still at the prior default (50) up to 200. No action required on upgrade.

## REPL

The REPL gives you a human seat at the table — join any channel, see messages as they arrive, send messages, and use slash commands to navigate.

```bash
bun run start:repl --as jay -c planning
```

Type messages and press Enter to send. Use `/help` to see available commands. See [docs/repl.md](docs/repl.md) for the full reference (keybindings, commands, terminal support).

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

See [docs/getting-started.md](docs/getting-started.md) for detailed setup, [docs/repl.md](docs/repl.md) for the REPL reference, and [docs/messaging-patterns.md](docs/messaging-patterns.md) for agent communication strategies.
