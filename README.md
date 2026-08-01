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

For periodic checks from outside the MCP session, `bun run poll` does a read-only unread check:

```bash
bun run poll --as my-agent                            # one-shot: exit 0 + JSON when unread exist, exit 1 when none
bun run poll --as my-agent --interval 5               # keep checking every 5s until something arrives
bun run poll --as my-agent --interval 5 --timeout 60  # ... giving up after 60s (exit 1)
```

It never advances cursors, so a Claude Code session can point its Monitor tool (or any loop) at this command and call `messaging_read_messages` to consume once it fires.

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

## Admin Plane (elevated access)

Approved 1st/3rd-party apps — issue-tracker bridges pushing events into
channels, analytics jobs querying message history — can integrate directly
with the storage layer over a **separate MCP connection**, without going
through the chat-style messaging tools:

```json
{
  "mcpServers": {
    "octo-santa-admin": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/octo-santa/src/admin.ts"]
    }
  }
}
```

The admin server exposes exactly two generic tools, **code-mode / programmatic
tool calling** style — they run **TypeScript**, not queries:

| Tool | Description |
|------|-------------|
| `admin_search` | Runs your code with each module's **read-only** API bound |
| `admin_execute` | Runs your code with each module's **full** API bound (controlled writes) |

Submitted code is an async function body: `await` freely and `return` a JSON
value — that value plus captured `console` output is the tool result, so you
look up state, act, filter, and aggregate in one round trip. The typed API is
described by a **typehead** — a TypeScript `.d.ts` composed from each module's
own fragment, served as MCP resource `octo-santa://admin/typehead.d.ts`. Raw
SQL never crosses the boundary; the SQLite storage module exposes controlled
methods (`storage.postMessage`, `storage.countMessages`, …) that uphold the
messaging invariants. Because every agent process watches the shared database,
`storage.postMessage(...)` *is* a push delivery.

```ts
// admin_execute — an issue-tracker bridge delivering an event:
storage.ensureChannel("eng-triage", "linear-hook");
const m = storage.postMessage({
  channel: "eng-triage", sender: "linear-hook",
  content: "LIN-142 moved to In Review", mentions: ["*"],  // ["*"] = @all
});
return { delivered: m.id };

// admin_search — OLAP over message history, only the digest returned:
const perSender = storage.countMessages({ channel: "eng-triage", groupBy: "sender" });
return Object.fromEntries(perSender.map((r) => [r.group, r.count]));
```

See [docs/specs/2026-08-01-admin-typehead-mcp.md](docs/specs/2026-08-01-admin-typehead-mcp.md).

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `OCTO_SANTA_DB` | `~/.octo-santa/messages.db` | Path to the shared SQLite database |
| `OCTO_SANTA_POLL_INTERVAL_MS` | `2000` | Push poller interval in ms |
| `OCTO_SANTA_HEARTBEAT_INTERVAL_MS` | `10000` | Agent liveness heartbeat interval in ms |
| `OCTO_SANTA_ADMIN_TIMEOUT_MS` | `5000` | Wall-clock timeout for a single admin code run |

## Development

```bash
bun test              # all tests
bunx tsc --noEmit     # typecheck
bun run build         # bundle → dist/<version>/{main,admin}.js
```

See [docs/getting-started.md](docs/getting-started.md) for detailed setup, [docs/architecture.md](docs/architecture.md) for the hexagonal architecture, and [docs/messaging-patterns.md](docs/messaging-patterns.md) for agent communication strategies.
