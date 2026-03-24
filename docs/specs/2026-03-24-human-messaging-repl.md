# Human Messaging REPL

A standalone entry point — peer to `src/server.ts` — that gives humans a direct
stdin/stdout interface to octo-santa's messaging functions. No MCP, no Claude, no
tokens. Same DB, same functions.

## Motivation

Agents communicate through octo-santa via MCP tools. Humans currently have no way
to participate in channels without routing through a Claude Code session, which
burns tokens and adds latency for what should be raw text input. The REPL is a
second transport for the same messaging core — MCP is for agents, the REPL is for
humans.

## Architecture

```
src/server.ts  ──> MCP transport ──> messaging functions ──> SQLite
src/repl.ts    ──> stdin/stdout  ──> messaging functions ──> SQLite
```

Both entry points import from `src/modules/messaging/tools.ts`. No new data layer,
no abstractions, no wrappers.

## Hard Requirement: Full Functional Parity with MCP

The REPL must expose every messaging function available through MCP, with the sole
exception of `claude/channel` push notifications (Claude Code-specific). This is
not aspirational — it is a functional requirement.

| MCP tool                    | REPL surface                                      |
|-----------------------------|----------------------------------------------------|
| `messaging_register`        | Automatic on startup via `--as <name>`             |
| `messaging_create_channel`  | Automatic on startup via `-c <channel>`, or `/create <name>` |
| `messaging_list_channels`   | `/channels`                                        |
| `messaging_send_message`    | Every line of stdin (REPL), `/send -f` (in-session file send), or `send` subcommand (fire-and-forget CLI) |
| `messaging_read_messages`   | Background poll (forward mode), `/history N` (before_id mode) |
| `messaging_list_agents`     | `/agents`                                          |

## Entry Points

### REPL mode (interactive)

```bash
bun run src/repl.ts -c planning --as jay
```

Opens an interactive session on the `planning` channel as agent `jay`.

### Send mode (fire-and-forget)

```bash
bun run src/repl.ts send -c planning -f brief.md --as jay
```

Reads file content, calls `sendMessage`, exits.

Without `-f`, reads from stdin (supports piping):

```bash
echo "quick note" | bun run src/repl.ts send -c planning --as jay
```

## REPL Mode Behavior

### Startup

1. Open DB at the same path as the MCP server (`OCTO_SANTA_DB` env or
   `~/.octo-santa/messages.db`).
2. Run migrations (`runMigrations(db, allMigrations)`) — the REPL may be the first
   process to touch the DB, so it must be self-sufficient.
3. Initialize in-memory cursor at the channel's current max message ID. The REPL
   does NOT call `registerAgent` or `subscribeToChannel` — it is a dedicated human
   actor, not an agent. No DB cursor rows are created for the human, which avoids
   inflating channel member counts that would affect DM/group notification mode.
   Read position is ephemeral — restarting the REPL starts fresh.
6. Start background poll loop.
7. Display prompt, ready for input.

### Sending Messages

Every line typed at the prompt is sent as a message via `sendMessage`. Mentions
(`@agent-name`, `@all`) work automatically — `sendMessage` already parses and
stores them server-side.

After a successful send, the REPL prints a local echo:

```
[jay] the message I just sent
```

This is necessary because `readMessages` filters out the caller's own messages
(`agent_id != ?`), so without local echo the user's own messages would be invisible
in the conversation flow.

### Receiving Messages

A background poll loop checks for new messages at a configurable interval
(default 1s — intentionally faster than the MCP server's 3s default, since humans
expect lower latency). Configured via `OCTO_SANTA_POLL_INTERVAL_MS`.

The poll covers **all channels the agent has a cursor on**, not just the active
channel. Messages from non-active channels include a channel prefix:

```
[agent-a] check the logs for the migration error
[agent-b] @jay should I wait for agent-a to finish?
[#ops][agent-c] deploy is done
```

Messages on the active channel omit the `#channel` prefix. When new messages
arrive mid-typing, they are printed above the current input line and the prompt is
redrawn. Use `node:readline` for prompt handling — no external TUI libraries.

### Slash Commands

| Command             | Action                                               |
|---------------------|------------------------------------------------------|
| `/channels`         | List all channels                                    |
| `/agents`           | List all registered agents                           |
| `/join <channel>`   | Switch active channel — changes where typed messages go and calls `subscribeToChannel` to init a cursor (subscribing to polls) without consuming unread. Does not leave previous channels — they continue to appear with `#channel` prefix. |
| `/create <channel>` | Create a new channel without switching                |
| `/history N`        | Show last N messages on current channel. Passes `before_id = MAX_SAFE_INTEGER` to get the most recent N messages. Does not advance cursor. **Note:** uses `readMessages` which filters `agent_id != ?` — the caller's own messages are excluded. This is intentional parity with the shared messaging layer; full-transcript history is a future shared-layer enhancement. |
| `/send -f <path>`   | Send file contents as a message on current channel    |
| `/help`             | Show available commands                               |

### Exit

Ctrl-C or `/quit` — cleans up poll timer and exits.

## Send Mode Behavior

1. Open DB, ensure channel exists via `sendMessage` (which calls `ensureAgent`).
2. Read content from `-f <path>` or stdin.
3. Call `sendMessage` with the content. No `registerAgent` — send mode is
   fire-and-forget, PID registration is wrong model for a short-lived process.
4. Print the sent message ID to stdout.
5. Exit.

## Arg Parsing

Minimal — `process.argv` parsing. No external dependencies.

- `--as <name>` (required) — agent identity for the human
- `-c <channel>` (required) — channel name
- `-f <path>` (send mode only) — file to send

## Identity Model

The human is a dedicated human actor, not an agent. There is no `registerAgent`
call — the REPL uses `ensureAgent` (via `sendMessage`) which creates a lightweight
agent row without PID or session ownership. This means:

- **No PID conflict check:** The REPL does not claim exclusive ownership of its
  `--as` name. A human could theoretically use `--as agent-a` while an MCP agent
  named `agent-a` is active. This is intentional — adding PID locking would
  require `registerAgent`, which would create cursor rows and re-introduce the
  DM/group membership inflation problem.
- **No DB cursors:** The REPL tracks read position in-memory. No cursor rows are
  created for the human (except by `sendMessage`'s sender cursor, which is filtered
  out of DM/group member counting via the PID-based query in `channel.ts`).
- **Ephemeral state:** Restarting the REPL starts fresh — no unread backlog is
  preserved across sessions.
- **Name validation:** `--as` values must match `[\w-]+` (letters, digits,
  underscores, hyphens). Reserved names `all` and `here` are rejected.
- Agents see human messages identically to any other agent's messages — there is
  no special `sender_type` or schema change.

## What This Does Not Include

- Multi-channel monitoring (future: `/monitor` across channels)
- Agent name autocomplete (future: tab-complete from registered agents)
- Colors or rich formatting (keep it plain for now)
- Any AI involvement
