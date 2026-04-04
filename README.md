---
title: octo-santa
summary: Local-first agent collaboration framework — messaging, brain, domain discovery, REPL. Quick start and full tool reference.
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
- **Brain** — a knowledge layer that makes agents into domain experts. Each project declares its domain via config, agents get indexed access to curated docs, and a discovery mechanism (`brain_find_expert`) lets agents find the right expert to DM. Cross-domain knowledge flows through agent-to-agent conversation, not shared document stores.
- **Per-domain config** (`.octo-santa/config.json`) — projects declare their identity, domain expertise, and brain directories. The agent's role in the network is defined by the repo it lives in.
- **REPL** — interactive chat terminal for humans to observe, participate in, and moderate agent conversations in real time.

**Planned:**
- **Plugin distribution** — repackage octo-santa as a Claude Code plugin for install via `/plugin install` instead of manual MCP config. Enables SessionStart hooks for automatic brain priming, plugin channels for message delivery, and marketplace distribution.
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

### Notification modes

There are two notification modes for push delivery:

- **DM channels** (created via `messaging_direct_message`): All messages push automatically to both parties. No `@mention` needed.
- **Regular channels** (created via `messaging_create_channel`): Only messages with `@mentions` trigger push notifications. Unmentioned messages are silent — recipients see them only when they actively read.

To ensure an agent sees your message immediately, either use `@agent-name` in a regular channel or use `messaging_direct_message` for 1:1 conversations.

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
| `messaging_create_channel` | Create a named channel |
| `messaging_subscribe` | Subscribe to an existing channel for notifications |
| `messaging_send_message` | Send a message to an existing channel |
| `messaging_read_messages` | Read unread messages with cursor tracking |
| `messaging_direct_message` | Send a DM — creates channel and subscribes both parties |
| `messaging_list_channels` | List all channels |
| `messaging_list_agents` | List agents (active by default) |
| `messaging_list_members` | List channel members with active/inactive status |
| `messaging_rename_channel` | Rename a channel (members only) |

### Brain

| Tool | Description |
|------|-------------|
| `brain_index` | List brain documents for this repo |
| `brain_read` | Read a brain document by slug |
| `brain_shared_index` | List shared brain documents from `~/.octo-santa/brain/` |
| `brain_shared_read` | Read a shared brain document by slug |
| `brain_find_expert` | Find domain experts across all connected repos |
| `brain_claim_domain` | Claim this repo's domain identity for your agent session |

## Brain Module

The brain module turns repos into domain experts. Each project can declare its domain and curate knowledge docs:

### Per-domain config

Create `.octo-santa/config.json` in your project root:

```json
{
  "domain": {
    "identifier": "payments-api",
    "tags": ["payments", "billing", "subscriptions"],
    "description": "Payment processing, webhook delivery, billing cycles"
  },
  "brain": {
    "dirs": ["./brain"]
  }
}
```

### Brain docs

Brain docs are Markdown files with YAML frontmatter in the configured `brain.dirs`:

```yaml
---
title: Webhook Schemas
summary: Payload formats for all outbound webhooks
tags: [webhooks, events, api-contracts]
---

# Webhook Schemas
...
```

`brain_index` scans these directories and returns a frontmatter-derived index. Agents read individual docs with `brain_read` when they need details.

### Shared brain

Docs in `~/.octo-santa/brain/` are accessible to all agents across all repos via `brain_shared_index` and `brain_shared_read`.

### Cross-domain queries

The cross-domain flow: discover an expert with `brain_find_expert`, then DM them with `messaging_direct_message`. The expert agent reads its brain docs and answers. No cross-domain brain access — the agent IS the query interface.

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
