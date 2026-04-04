---
title: REPL Redesign
summary: Third-generation REPL design using raw stdin and ANSI escape codes, replacing readline and Ink implementations
tags: [repl, terminal, multiline, messaging]
---

# REPL Redesign

A standalone interactive chat interface for octo-santa's messaging system. Peer to `src/mcp.ts` — MCP is for agents, the REPL is for humans.

## Motivation

Two previous REPL implementations failed:
1. **v1 (readline)** — worked for single-line messages, couldn't handle multiline input (readline's cooked mode makes Enter/Shift+Enter indistinguishable)
2. **v2 (Ink/React)** — severe flickering made it unusable (framework re-renders entire component tree on every state change, causing visual thrashing with concurrent input + incoming messages)

Both removed. The messaging layer (`tools.ts`, `channel.ts`) is intact and unchanged. This spec defines the third attempt using raw stdin + ANSI escape codes with no framework.

## Scope

**In scope (SLC v1):** Interactive chat — sit in a channel, send and receive messages in real-time with a polished typing experience.

**Out of scope:** Fire-and-forget send mode (dropped — no demonstrated need). Can be added later.

## Approach

**Raw stdin + ANSI escape codes.** No Ink, no terminal-kit, no blessed. Own the rendering pipeline end-to-end. Previous failures were framework-related — going framework-free means we control exactly what gets written to the terminal and when.

Patterns validated via GitHits — qwen-code, gemini-cli, eliza all use this approach for similar CLI chat/editor UIs.

## Entry Point

```bash
bun run src/repl/index.ts --as jay -c planning
```

Or via compiled binary. `--as <name>` sets the human's identity, `-c <channel>` sets the initial channel.

## Input

### Submit and Newlines

Enter sends the message. Shift+Enter inserts a newline.

**Kitty keyboard protocol** (`\x1b[>1u` on startup, `\x1b[<u` on exit) — Shift+Enter arrives as `\x1b[13;2u`. Supported by Ghostty, Kitty, WezTerm, iTerm2, Windows Terminal.

**Fallback for unsupported terminals** (e.g. Terminal.app): Enter always sends, no multiline typing. Same behavior as the old readline REPL — no regression. Multiline paste still works via bracketed paste (separate protocol).

### Editing Shortcuts

Standard terminal/editor key bindings — this was broken in the previous REPL and is part of the SLC bar:

| Key            | Action                                                            |
|----------------|-------------------------------------------------------------------|
| Arrow keys     | Character/line movement                                           |
| Alt+Left/Right | Skip word                                                         |
| Home / Ctrl+A  | Start of line                                                     |
| End / Ctrl+E   | End of line                                                       |
| Ctrl+W         | Delete word backward                                              |
| Ctrl+U         | Delete to start of line                                           |
| Ctrl+K         | Delete to end of line                                             |
| Backspace      | Delete character backward (joins lines across newline boundaries) |
| Delete         | Delete character forward (joins lines across newline boundaries)  |
| Ctrl+C         | Exit immediately                                                  |

### Bracketed Paste

**Protocol:** `\x1b[?2004h` to enable on startup, `\x1b[?2004l` to disable on exit. Terminal wraps pasted content in `\x1b[200~` ... `\x1b[201~` markers. Widely supported — even Terminal.app.

**Behavior:** While inside paste brackets, Enter inserts a newline instead of submitting. This ensures pasting a 3-line code block inserts 3 lines into the buffer rather than firing 3 separate messages.

**Sanitization:** Strip ANSI escape sequences from pasted content before inserting into the buffer. Pasted text from terminals may contain color codes (`\x1b[31m` etc.) — the buffer is plain text only. Without stripping, invisible escape sequences corrupt buffer state and break cursor positioning.

**Batch insert:** Accumulate all bytes within paste brackets and emit a single insert action, not character-by-character. This gives the renderer one redraw per paste instead of N redraws for N characters. Without batching, pasting 500 characters causes 500 redraws — visible flicker.

## Display

### Prompt

`channel> ` — just the channel name. e.g. `planning> `

### Startup

Clean screen, just the prompt. Use `/history N` to pull context on demand.

### Message Rendering

Light coloring — agent names colored (hash-based assignment from a fixed palette so each agent gets a consistent color within a session), `[#channel]` prefixes dimmed/highlighted to distinguish from message content, `[error]` in red. No rich/token-level formatting.

Clear visual separation — blank line between every message for consistent spacing. No timestamps in v1 — structure should accommodate them later.

**Multiline messages:** Continuation lines indented to align with the first character of message content on the first line. Messages with internal indentation are offset correctly.

```
[agent-a] first line of the message
          second line continues here
            indented code block
            more indented code
          back to normal
```

### Channel Prefixes

Messages from the active channel omit the channel prefix. Messages from other channels include `[#channel]`:

```
[agent-a] check the logs

[#ops][agent-c] deploy is done
```

### Error Display

Separate from the message stream — distinct styled line so it doesn't look like a chat message:

```
[agent-a] hey check the logs

[error] failed to send: database is locked

planning> 
```

### Scrollback

Terminal native — messages print to stdout, terminal's own scroll (mouse wheel, trackpad, Shift+PgUp) handles scrollback. No alternate screen buffer.

**Tradeoff:** incoming messages while scrolled back jump to bottom. Acceptable for chat.

**Rendering implication:** The only challenge is the input area at the bottom. When a message arrives mid-typing, print it above the current input line and redraw the prompt. No full-screen layout management needed.

### Terminal Resize

**Safe-clear strategy:** On resize, move cursor to the start of the input area (column 0 of the first input line), then clear from cursor to end of screen (`\x1b[J`), then redraw with new width. Do NOT try to calculate how many wrapped lines the old input occupied at the old width — that count is stale after resize and clearing the wrong number of lines corrupts the message history above. Clearing downward from the input start is always safe because the input area is always at the bottom.

**Debounce:** SIGWINCH fires on every pixel of a drag resize. Debounce redraws with a 100ms timer — reset the timer on each signal, only redraw when the timer fires. The input area looks briefly wrong during the drag but snaps correct when the user stops. Without debounce, rapid redraws cause flicker (the same failure mode that killed the Ink REPL).

## Slash Commands

All previous commands carry over. Most are a single call to `tools.ts` or direct SQL; `/join` mutates local state; `/send -f` reads a file; `/help` and `/quit` are self-contained. Behind `/` prefix so invisible until needed.

| Command             | Action                                                                                                      |
|---------------------|-------------------------------------------------------------------------------------------------------------|
| `/channels`         | List all channels                                                                                           |
| `/agents`           | List all known agents                                                                                       |
| `/join <channel>`   | Switch active channel                                                                                       |
| `/create <channel>` | Create a new channel without switching                                                                      |
| `/history [N]`      | Show last N messages on current channel including own (default 20, invalid/non-positive N falls back to 20) |
| `/send -f <path>`   | Send file contents as a message                                                                             |
| `/members`          | List members of current channel                                                                             |
| `/help`             | Show available commands                                                                                     |
| `/quit`             | Exit                                                                                                        |

**Command vs message disambiguation:** Two rules, applied in order:
1. **Multiline submits are always messages.** If the buffer contains newlines, the entire content is sent as a message, even if the first line starts with `/`. This is enforced in both `parseCommand()` (rejects multiline input) and the app layer (checks before calling `parseCommand`).
2. **Single-line submits starting with `/` are commands only if the first token matches a known command name** (`channels`, `agents`, `join`, `create`, `history`, `send`, `members`, `help`, `quit`). Unknown tokens like `/path/to/file` are sent as plain messages. This ensures users on non-Kitty terminals (who can't type multiline) can still send slash-prefixed text without an escape hatch.

**Design decision: commands are always single-line.** Future commands that need multiline bodies (e.g. `/schedule` with a cron expression and message body) will use a different mechanism — either a file reference (`/schedule (* * 1 * *) -f message.txt`) or a sub-prompt that opens after the command line is submitted. This preserves total paste protection (pasted text starting with `/` on the first line of a multiline paste is never executed as a command) and keeps command parsing simple.

## Identity Model

The REPL human uses `ensureAgent` (lightweight, no PID lock), not `registerAgent`. This means:
- No PID conflict check — multiple sessions can use the same `--as` name
- No DB cursors for polling — read position tracked in-memory, ephemeral across restarts
- Human doesn't inflate channel member counts for DM/group mode detection
- Agents see human messages identically to any other agent's messages
- Humans appear in `/members` after sending a message (cursor row created by `sendMessage`) — this is expected and consistent with the shared messaging layer

## App State

The app maintains explicit local state for channel management:

```typescript
interface ReplState {
  activeChannel: string;           // where typed messages go
  joinedChannels: Set<string>;     // all channels being monitored
  cursors: Map<string, number>;    // channel name → last seen message ID (in-memory only)
  agentId: string;                 // --as identity
}
```

**`/join <channel>` behavior:** Adds the channel to `joinedChannels`, sets it as `activeChannel`, initializes cursor at the channel's current max message ID (subscribe from now, no backlog replay). Previous channels remain in `joinedChannels` and continue to appear with `[#channel]` prefix.

**Poll loop:** Uses direct SQL queries against the messages table with in-memory cursors from `ReplState.cursors`. Does NOT use `readMessages` from `tools.ts` — that function advances DB cursors, which conflicts with the in-memory-only identity model. Only `sendMessage` goes through `tools.ts`.

**Poll interval:** 1s default (configurable via `OCTO_SANTA_POLL_INTERVAL_MS`). Faster than MCP's 3s default — humans expect lower latency.

**Poll/self-echo contract:** The poll query MUST exclude `agent_id = state.agentId`. The user's own messages are rendered only via local echo after `sendMessage()` — never via the poll loop. Cursors advance only from polled non-self rows (`SET cursor = MAX(polled_message_ids)`). This prevents two failure modes:
- **Duplication:** If poll includes self messages, the user sees their own message twice (local echo + poll).
- **Skipped messages:** If an implementer "fixes" duplication by advancing the cursor to the sent message ID, they skip any peer messages that arrived between the previous cursor and the send — those messages are never rendered.

## Architecture

Five layers, each with a single responsibility and clean boundary:

### 1. Input Buffer (`buffer.ts`) — pure data, no I/O

The text editing state machine.

**State:** `lines: string[]`, `cursorRow`, `cursorCol`, `preferredCol`

**Operations:**
- `insert(text)` — insert at cursor, handles newlines
- `backspace()` / `delete()` — character delete, joins lines across boundaries
- `move(direction)` — left, right, up, down, wordLeft, wordRight, home, end
- `deleteWord()` — Ctrl+W, `deleteToEnd()` — Ctrl+K, `deleteToStart()` — Ctrl+U
- `submit()` — extract full text, reset to empty
- `clear()` — discard input without submitting

**Word boundary rules:** Word movement (Alt+Left/Right) and word deletion (Ctrl+W) use Unicode-aware `\b`-style boundaries: word characters are `[\w\p{L}\p{N}]` (letters, digits, underscores across scripts). Skip consecutive word characters, then skip consecutive non-word characters (or vice versa). This matches standard terminal editor behavior — `foo_bar` is one word, `foo.bar` is two.

**Unicode scope (v1):** The buffer operates on UTF-16 code units (JavaScript string indices). `cursorCol` is a code-unit offset. This means:
- **ASCII and BMP text:** works correctly (one code unit = one character = one display column).
- **Emoji, astral plane characters:** occupy two UTF-16 code units (surrogate pairs). Cursor movement and deletion can split a surrogate pair, producing corrupt characters in the buffer. This is a known editing bug, not just a visual mismatch.
- **CJK full-width characters:** display as two columns but count as one code unit. Cursor positioning will be visually offset.
- **Combining marks:** cursor may land between a base character and its combining mark.

Full grapheme-aware cursoring (via `Intl.Segmenter`) and display-width calculation (via `wcwidth`) are deferred to a future version. For v1, the primary user (English-language agent messaging) is unaffected. This is an explicit, documented limitation.

**Boundary:** Pure data structure. No stdin, no stdout, no ANSI. Fully testable without a terminal.

### 2. Key Parser (`keys.ts`) — raw bytes → semantic actions

Translates raw stdin data into actions the app can dispatch.

**Owns:**
- Kitty protocol enablement and teardown
- Bracketed paste mode (detection, sanitization, batch accumulation)
- Escape sequence parsing (CSI sequences for arrows, modifiers, Home/End, Delete)
- Key mapping (see Input section above)
- Fallback behavior when Kitty protocol is unavailable

**Stream parsing:** stdin `data` events can split escape sequences across chunks (e.g., `\x1b[1;3` in one chunk, `D` in the next). The parser maintains an internal `pendingBytes` buffer to accumulate incomplete sequences. When a chunk arrives:
1. Prepend any `pendingBytes` from the previous chunk
2. Consume complete sequences and printable characters, emitting actions
3. If the buffer ends with a partial escape sequence, hold it in `pendingBytes` for the next chunk

**Esc timeout:** A lone `\x1b` byte is ambiguous — it could be the start of an escape sequence (Alt+key, CSI) or the user pressing Escape. After receiving `\x1b` with no following bytes, set a 50ms timer. If more bytes arrive within 50ms, combine them into the sequence. If the timer fires, emit a standalone Escape action (currently unused, but prevents hanging state).

**Boundary:** `parse(rawBytes: Buffer) → Action[]`. State: `kittyEnabled` flag, `inPaste` flag, `pasteBuffer` accumulator, `pendingBytes` buffer, `escTimer` handle. Testable with byte sequences as input, including fragmented multi-chunk sequences.

### 3. Renderer (`renderer.ts`) — state → terminal output

All stdout writes go through here. Nothing else writes to stdout.

**Owns:**
- Prompt + input buffer drawing with correct cursor positioning
- Input area redraw (clear and rewrite on keystroke)
- Print-above (incoming message mid-typing: print above input, redraw input)
- ANSI color formatting (applied by the renderer, after sanitization)
- Message formatting (multiline indentation, visual gaps)
- Terminal width tracking and SIGWINCH handling (safe-clear + debounce)
- **Output sanitization:** All displayed content — message bodies, agent IDs, channel names, error strings — is sanitized before rendering. Strip ANSI escape sequences and control characters except `\n` and `\t`. Tabs are preserved and expanded to spaces during rendering (4-space tab stops). This prevents agents from injecting sequences that corrupt the REPL display (clear screen, spoof prompts, overwrite output) while preserving legitimate code/message formatting. Sanitization happens in the renderer, not in the messaging layer — the shared layer stores content as-is.

**Render serialization:** Multiple sources trigger renders concurrently — keystrokes, poll ticks, command output, send errors, debounced resize. To prevent interleaved ANSI sequences (which cause display tearing), all render triggers go through a single synchronous render cycle: `event → state mutation → render`. Since Bun/Node is single-threaded, the event loop already serializes `data` events, `setInterval` callbacks, and `setTimeout` callbacks. The rule is: **never write to stdout outside a render call, and never call render from inside another render.** The renderer exposes a small API — `renderInput()`, `printMessage()`, `printOutput()` — and the app calls exactly one of these per event. No render queue is needed because the event loop provides serialization; we just need discipline about the single-writer rule.

**Boundary:** One-way data flow. Takes state (buffer content, cursor pos, messages), writes to stdout. Never reads stdin.

### 4. Commands (`commands.ts`) — slash command dispatch

Two-part design: pure parser + impure executor.

**Owns:**
- `parseCommand(input)` — pure function, returns `{ name, args }` or null. Matches first token against known command names.
- `executeCommand(parsed, db, context)` — impure executor. Calls `tools.ts` for DB operations (`/channels`, `/agents`, `/members`), uses direct SQL for `/history` (see below), reads filesystem for `/send -f`, mutates `ReplState` for `/join`. Returns `CommandResult: { output: string[], channelChange?: string, exit?: boolean }`.

**Boundary:** Parser is pure and testable without DB. Executor is impure but returns structured output — no direct stdout writes. The app feeds `CommandResult` to the renderer.

**`/history` implementation:** Uses a direct SQL query — NOT `readMessages` from `tools.ts` (which filters `agent_id != ?` and would exclude the caller's own messages). A human reviewing chat history expects to see the full transcript. Query shape: `SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?` with `before_id = MAX_SAFE_INTEGER` for most-recent. Does not advance any cursor.

### 5. App (`app.ts`) — orchestration

Wires everything together. The only layer that knows about all the others.

**Owns:**
- Startup: parse args, open DB, run migrations, enable raw mode, init Kitty protocol, enable bracketed paste
- Main loop: stdin `data` → key parser → dispatch to buffer or commands
- Poll loop: `setInterval` → check for new messages → feed to renderer
- Submit handling: single-line starting with `/` → commands; otherwise → `sendMessage()` + local echo
- Shutdown: disable raw mode, restore Kitty protocol, disable bracketed paste, clean up poll timer

**Boundary:** No business logic — just plumbing.

### Data Flow

```
stdin (raw bytes)
  → Key Parser (parse → Action[])
  → App (dispatch)
      ├─ buffer action → Input Buffer (state update) → Renderer (redraw input)
      ├─ submit → Commands or sendMessage → Renderer (print output/echo)
      └─ exit → Shutdown

poll timer
  → direct SQL query (in-memory cursors from ReplState)
  → App (update cursors)
  → Renderer (print above + redraw input)
```

### File Structure

```
src/
  repl/
    index.ts       — entry point (parse args, bootstrap, start app)
    app.ts         — orchestration
    buffer.ts      — input buffer state machine
    keys.ts        — raw keystroke parser
    renderer.ts    — terminal output
    commands.ts    — slash command handlers
```

## Success Criteria

### Essential — must pass before the feature ships

| #   | Criterion                                         | How to verify                                                                                                                                                                         |
|-----|---------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| E1  | Type a message and send with Enter                | Launch REPL, type text, press Enter. Message appears as local echo.                                                                                                                   |
| E2  | Receive messages from other agents within ~1s     | Open two REPL sessions on the same channel. Send from one, verify it appears in the other within 1 second.                                                                            |
| E3  | Shift+Enter inserts newline (Kitty terminals)     | In Ghostty/Kitty/WezTerm: Shift+Enter adds a line, Enter sends the full multiline message.                                                                                            |
| E4  | Paste multiline text inserts as one block         | Paste a 3+ line code block. Verify it enters the buffer as one block, not 3 separate messages. Verify on both Kitty and non-Kitty terminals (bracketed paste is separate from Kitty). |
| E5  | Full cursor traversal shortcuts work              | Alt+Left/Right skips words. Home/End jumps to line boundaries. Ctrl+A/E same. Ctrl+W deletes word. Ctrl+U/K delete to start/end. Backspace/Delete work across newline boundaries.     |
| E6  | Slash commands work                               | Each of: `/channels`, `/agents`, `/join`, `/create`, `/history`, `/send -f`, `/members`, `/help`, `/quit` — produces correct output.                                                  |
| E7  | `/history` includes own messages                  | Send a message, run `/history 5`. Both own and others' messages appear.                                                                                                               |
| E8  | Own messages never appear twice                   | Send a message. Verify local echo appears once. Wait for poll cycle. Verify no duplicate.                                                                                             |
| E9  | No messages skipped by poll                       | While one REPL is idle, send 5 messages from another session. All 5 appear in order.                                                                                                  |
| E10 | Terminal restored on exit                         | Ctrl+C exits. Verify terminal is not stuck in raw mode (typing works normally after exit).                                                                                            |
| E11 | Malicious message content doesn't corrupt display | Send a message containing `\x1b[2J` (clear screen) from another agent. Verify the REPL renders it as plain text, not as an escape sequence.                                           |
| E12 | All automated tests pass                          | `bun test` — all tests green, no regressions in existing messaging tests.                                                                                                             |
| E13 | Cross-channel messages show `[#channel]` prefix   | `/join` a second channel. Receive messages on the first channel. Verify they show with `[#channel]` prefix.                                                                           |
| E14 | Multiline message rendering is correctly indented | Receive a multiline message from another agent. Continuation lines align with the first character of content on the first line.                                                       |
| E15 | Commands are single-line only                     | Type `/join foo` and press Enter → executes command. Paste `/join foo\nbar` → sends as message. Type `/path/to/file` → sends as message (not a known command).                        |

### Stretch — nice to have, not blocking

| #  | Criterion                               | How to verify                                                                                                                                   |
|----|-----------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------|
| S1 | Terminal resize doesn't corrupt display | Type a long message, resize terminal by dragging. Input area redraws correctly after resize settles. No message history corruption.             |
| S2 | Compiled binary works                   | `bun run build:repl` produces `dist/<ver>/ocr`. Run `./dist/<ver>/ocr --as jay -c planning` — works identically to `bun run src/repl/index.ts`. |
| S3 | Fallback for non-Kitty terminals        | In Terminal.app (no Kitty protocol): Enter sends, no multiline typing, but paste multiline still works. No crash, no error.                     |
| S4 | Large paste performance                 | Paste 1000+ characters. Single redraw, no visible flicker, buffer contains the full text.                                                       |
| S5 | Visual gap between messages             | Blank line separates every message. Different-channel messages have additional `[#channel]` prefix for visual distinction.                      |

## Scaling Limits

**Terminal native scrollback vs. persistent UI elements:** If future versions need a status bar (unread counts, connection status), terminal native scrollback doesn't support fixed-position elements. Options: always redraw a status line above input (feasible but fragile), or switch to alternate screen buffer (breaks scrollback). This is a v3+ concern — the architecture doesn't prevent evolving `renderer.ts` independently of other layers.

## Future / Roadmap

- Cron-scheduled messages via `/schedule` command (REPL-only, not MCP)
- Timestamps on messages
- Agent name tab-completion
