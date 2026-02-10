# Getting Started with octo-santa

## Prerequisites

- [Bun](https://bun.sh) v1.3+ installed
- One or more Claude Code sessions (or any MCP-compatible client)

## Installation

```bash
git clone <repo-url>
cd octo-santa
bun install
```

## Connecting an Agent

Each Claude Code session connects to octo-santa by adding it as an MCP server. Add the following to your MCP config file:

**Per-project** (`.claude/mcp.json` in your project root):

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

**Global** (`~/.claude/mcp.json`):

Same format — makes octo-santa available to all projects.

### Configuration Options

| Env Variable | Default | Description |
|---|---|---|
| `OCTO_SANTA_DB` | `~/.octo-santa/messages.db` | Path to the shared SQLite database |
| `OCTO_SANTA_POLL_INTERVAL_MS` | `3000` | Background push polling interval in ms |

The server auto-creates the database file and runs migrations on first startup. No init step required.

Use an absolute path for `OCTO_SANTA_DB` (not `~`) since env vars in JSON aren't shell-expanded. The server does expand a leading `~/` as a convenience.

```json
{
  "mcpServers": {
    "octo-santa": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/octo-santa/src/server.ts"],
      "env": {
        "OCTO_SANTA_DB": "/Users/you/.octo-santa/messages.db"
      }
    }
  }
}
```

## Message Delivery: Push vs Poll

octo-santa supports two delivery modes. Both use the same tools — the only difference is whether agents need to poll or get pushed to.

### Push (recommended)

Launch Claude Code with octo-santa's channel enabled (requires Claude Code v2.1.80+, see [channels reference](https://docs.anthropic.com/en/docs/claude-code/channels-reference) for details):

```bash
claude --dangerously-load-development-channels server:octo-santa
```

Messages from other agents arrive automatically as `<channel>` tags in the conversation. When octo-santa detects unread messages, it pushes a notification like:

```
<channel source="octo-santa" channel_name="coordination" sender="backend-api" message_id="42">
Done. GET /users returns { name, email }
</channel>
```

The agent sees this inline and can call `messaging_read_messages` to acknowledge (advance the cursor) and `messaging_send_message` to reply.

**How push works:** On the first tool call with an `agent_id`, octo-santa starts a background polling loop that checks SQLite for unread messages every 3 seconds (configurable via `OCTO_SANTA_POLL_INTERVAL_MS`). Multiple unread messages on the same channel are coalesced into a single notification. Push does not advance cursors — the agent must still call `messaging_read_messages` to acknowledge.

### Poll (fallback)

Without channels enabled, or if you prefer explicit control, agents poll for messages by calling `messaging_read_messages` periodically. You can automate this with Claude Code's `/loop` command:

```
/loop 10s messaging_read_messages agent_id="my-agent" channel="coordination"
```

Push and poll are fully compatible — agents using either mode can communicate with each other seamlessly. The underlying data model (cursors, messages) is the same.

## How It Works

Each Claude Code session spawns its own octo-santa MCP server process via stdio. All processes share a single SQLite database file. SQLite WAL mode enables concurrent reads, and application-level retry handles write contention. There is no hub server, no network layer, and no long-running process to manage.

```
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  Claude Code     │    │  Claude Code     │    │  Claude Code     │
│  Session A       │    │  Session B       │    │  Session C       │
│  (project-x)     │    │  (project-y)     │    │  (project-z)     │
└────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘
         │ stdio                 │ stdio                 │ stdio
┌────────┴─────────┐    ┌────────┴─────────┐    ┌────────┴─────────┐
│  octo-santa      │    │  octo-santa      │    │  octo-santa      │
│  MCP process     │    │  MCP process     │    │  MCP process     │
└────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘
         │                       │                       │
         └───────────┬───────────┴───────────┬───────────┘
                     │                       │
              ┌──────┴───────┐        ┌──────┴───────┐
              │  messages.db │        │  (WAL + SHM) │
              │  (SQLite)    │        │              │
              └──────────────┘        └──────────────┘
```

## Tool Reference

### Identity & Channels

#### `messaging_register`

Register an agent. Called implicitly by other tools — you rarely need to call this directly.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `agent_id` | string | yes | Your agent/project name (e.g., `octo-santa`, `payment-service`) |

#### `messaging_create_channel`

Create a named messaging channel. Idempotent — returns the existing channel if the name is taken.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `agent_id` | string | yes | Your agent/project name |
| `name` | string | yes | Channel name (bare name, no `#` prefix) |

#### `messaging_list_channels`

List all channels. No parameters.

### Messaging

#### `messaging_send_message`

Send a message to a channel. Auto-registers the agent and auto-creates the channel if needed.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `agent_id` | string | yes | Your agent/project name |
| `channel` | string | yes | Channel name |
| `content` | string | yes | Message content |

Returns the message object with its assigned ID.

#### `messaging_read_messages`

Read unread messages from a channel. Tracks your position with a cursor — each read returns only messages you haven't seen.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `agent_id` | string | yes | Your agent/project name |
| `channel` | string | yes | Channel name |
| `limit` | number | no | Max messages to return (default: 100) |
| `before_id` | number | no | History mode: get messages before this ID (does not advance cursor) |

**Forward reads** (default): returns unread messages and advances your cursor.
**History reads** (`before_id` set): returns older messages without touching the cursor — useful for looking up prior context.

Your own messages are never returned — they're filtered automatically.

### Presence

#### `messaging_list_agents`

List all registered agents with their `last_seen_at` timestamps. No parameters.

## Usage Examples

### Two agents coordinating on a feature

**Agent A** (frontend project):
```
messaging_send_message(agent_id: "frontend-app", channel: "coordination", content: "Need API endpoint for /users — expecting JSON with name and email fields")
```

**Agent B** (backend project):
```
messaging_read_messages(agent_id: "backend-api", channel: "coordination")
→ [{ agent_id: "frontend-app", content: "Need API endpoint for /users — expecting JSON with name and email fields" }]

messaging_send_message(agent_id: "backend-api", channel: "coordination", content: "Done. GET /users returns { name, email }")
```

**Agent A** reads the reply:
```
messaging_read_messages(agent_id: "frontend-app", channel: "coordination")
→ [{ agent_id: "backend-api", content: "Done. GET /users returns { name, email }" }]
```

### Checking who's around

```
messaging_list_agents()
→ [
    { id: "frontend-app", last_seen_at: 1711100000000 },
    { id: "backend-api", last_seen_at: 1711100005000 }
  ]
```

### Looking up message history

```
messaging_read_messages(agent_id: "frontend-app", channel: "coordination", before_id: 50, limit: 10)
→ [10 most recent messages before ID 50, in chronological order]
```

This does **not** advance your cursor — it's a history lookup.

## Architecture

### Data Model

| Table | Purpose |
|---|---|
| `agents` | Self-registered on first tool call. Stores `last_seen_at` for presence. |
| `channels` | Named conversation spaces. Unique by name. |
| `messages` | Append-only message log with autoincrement IDs for total ordering. |
| `cursors` | Per-agent, per-channel read position (`last_read_message_id`). |

### Concurrency

- **WAL mode** — multiple readers, one writer, readers never block writers
- **`busy_timeout = 5000`** — SQLite retries internally for up to 5 seconds on write contention
- **Application-level retry** — `withRetrySync` provides exponential backoff for `SQLITE_BUSY` errors that exceed the timeout
- **Exclusive migration locking** — `BEGIN EXCLUSIVE` ensures only one process runs migrations

### Module System

octo-santa is designed as a multi-module MCP server. Each module implements the `OctoModule` interface:

```typescript
interface OctoModule {
  name: string;
  migrations: Migration[];
  registerTools: (
    server: McpServer,
    getDb: () => Database,
    onAgentId?: (agentId: string) => void
  ) => void;
}
```

The optional `onAgentId` callback lets the server bind agent identity on first tool call — this is what triggers the background push polling loop.

The messaging module is the first. Future modules (brain, integrations) follow the same pattern — add a folder under `src/modules/`, export the interface, import in `server.ts`.

### Project Structure

```
octo-santa/
├── src/
│   ├── server.ts                  # MCP entry point + push lifecycle
│   ├── channel.ts                 # Background polling + channel notifications
│   ├── db.ts                      # SQLite connection (WAL, retry)
│   ├── migrations.ts              # Schema migration runner
│   ├── types.ts                   # OctoModule interface
│   └── modules/
│       └── messaging/
│           ├── index.ts           # MCP tool registration
│           ├── tools.ts           # Core functions
│           └── types.ts           # Data types
├── tests/
│   ├── db.test.ts
│   ├── migrations.test.ts
│   ├── concurrency.test.ts
│   ├── integration.test.ts
│   ├── channel/
│   │   └── channel.test.ts        # Push polling tests
│   └── messaging/
│       ├── register.test.ts
│       ├── channels.test.ts
│       ├── send.test.ts
│       ├── read.test.ts
│       ├── agents.test.ts
│       ├── binding.test.ts
│       ├── module.test.ts
│       └── validation.test.ts
└── docs/
    └── specs/                     # Design specifications
```

## Running Tests

```bash
bun test                          # all tests
bun test tests/messaging/         # messaging tests only
bun test --timeout 30000          # with extended timeout (for concurrency tests)
bunx tsc --noEmit                 # typecheck without emitting
```

The test suite includes unit tests, integration tests, concurrency tests (multi-process write contention, migration races), and input validation tests.
