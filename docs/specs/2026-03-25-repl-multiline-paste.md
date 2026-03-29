> **Superseded** by [2026-03-28-repl-ink-rewrite](2026-03-28-repl-ink-rewrite.md).
> Multiline input is now handled natively via Ink's raw mode and Kitty keyboard protocol.
> The `PasteAwareStream` / bracketed-paste approach described here was removed.
> This spec is retained for historical context.

# REPL Multi-Line Paste Support

Amends `2026-03-24-human-messaging-repl.md`: adds paste-buffering behavior to the "Enter sends immediately" and "Ctrl+C exits" rules. Normal typed input is unchanged; paste mode is an additional state.

## Problem

When pasting multi-line content into the REPL, each line fires a separate readline `line` event and gets sent as an individual message. Users need to paste code snippets, logs, and structured text as a single message.

## Approach: PasteAwareStream wrapper

A PassThrough stream sits between `process.stdin` and readline. It intercepts bracketed paste escape sequences (`\x1b[200~` / `\x1b[201~`), strips them, and buffers content during paste. The key property: `push()` is synchronous — when the wrapper pushes buffered paste content to readline, `line` events fire *during* the push while `isPasting` is still `true`. This solves the timing issue that makes a separate `data` listener approach impossible.

### Why not a separate stdin data listener?

Empirically verified under Bun 1.3.11: when start and end markers arrive in the same chunk (the most common case for small pastes), the `data` handler processes the entire chunk first, clearing `isPasting` before readline fires any `line` events. The flag is stale by the time line events run.

## Design

### PasteAwareStream

A `PassThrough` subclass wrapping `process.stdin`:

- Listens on source `data` events
- Parses each chunk for `\x1b[200~` (start) and `\x1b[201~` (end)
- Outside paste: pushes data through to readline unchanged
- During paste: buffers content, strips markers
- On paste end: pushes buffered content (triggers readline synchronously while `isPasting` is still `true`), then clears `isPasting`
- Implements `_destroy()` to explicitly unregister its `data`/`end`/`error` listeners from the source stream (Node's `destroy()` does not clean up manually-attached listeners on `process.stdin`)
- Proxies `isTTY`, `setRawMode()`, `ref()`, `unref()` from source stream for readline compatibility

Only created when `process.stdin.isTTY && process.stdout.isTTY`. When not a TTY, readline uses `process.stdin` directly (no paste support, no bracketed paste escape sequences written).

### Bracketed paste mode

Enable at startup: write `\x1b[?2004h` to stdout.
Disable on shutdown: write `\x1b[?2004l` to stdout.
Only when TTY.

### State machine

Three pieces of state govern the line handler:

- `stream.isPasting` — true between paste-start and paste-end sequences
- `pasteBuffer: string[]` — lines collected during paste
- `pasteSeen: boolean` — set true when any paste start is detected (via `stream.isPasting` transitioning to true), cleared when the buffer is sent or discarded. This covers the single-line-paste edge case where `pasteBuffer` is empty but content is pending in `rl.line`.

The line handler checks these in order:

1. **`stream.isPasting` is true**: set `pasteSeen = true`. Append line to `pasteBuffer` (do not send). These are lines from the current paste, delivered synchronously during the stream's `push()`. Subsequent pastes before Enter append to the same buffer.
2. **`pasteSeen` is true** (paste ended, waiting for confirm): if line is non-empty, append it to buffer (captures the final pasted line when paste had no trailing newline — readline holds it in `rl.line` until Enter). Then join buffered lines with `\n`, send as single message, clear `pasteBuffer` and `pasteSeen`. **Pasted content is not trimmed** — indentation, blank lines, and whitespace are preserved verbatim. Only the `\n` join is normalized.
3. **Otherwise**: normal input — trim and send immediately (existing behavior).

### Content preservation

Pasted content preserves visible text and whitespace (indentation, blank lines) — no trimming. The current REPL trims typed input before sending; this trimming must only apply to the passthrough path (step 3), not to pasted content (step 2). Note: multibyte UTF-8 characters split across chunk boundaries may be corrupted; this is a known limitation of per-chunk `toString("utf-8")` decoding and is extremely rare in practice.

### Local echo

The local echo for sent pasted content must pass through `sanitize()` before printing with `printAbove()`. This prevents ANSI escape sequences and control characters in pasted logs/code from corrupting the terminal display. (Incoming messages from other agents already go through `formatMessage` which uses `sanitize`.)

### User flow

1. User pastes multi-line content into the REPL
2. Terminal sends bracketed paste sequences; PasteAwareStream intercepts and buffers
3. Readline receives clean content (no markers), fires `line` events — handler buffers them
4. User presses **Enter** to send all buffered lines as a single message
5. Or user presses **Ctrl+C** to discard the paste buffer and return to normal input

Single-line pastes follow the same flow.

### Ctrl+C behavior

Use `rl.on("SIGINT")` (not `process.on("SIGINT")`) — this is the reliable hook under Bun's TTY mode. When `pasteSeen` is true (covers all paste states: active paste, pending multi-line buffer, and single-line paste with content only in `rl.line`), Ctrl+C clears `pasteBuffer`, clears `pasteSeen`, clears the current readline line with `rl.write(null, { ctrl: true, name: "u" })`, and redraws the prompt. When no paste is pending (`pasteSeen` is false), Ctrl+C exits as before.

### Idempotent shutdown

The `shutdown` function must be idempotent (guard with a `shuttingDown` boolean against re-entrant calls from `rl.on("close")`). On shutdown: write `\x1b[?2004l`, clear poll timer, call `stream.destroy()` (triggers `_destroy()` which unregisters source listeners), close readline, exit.

## Scope

| File | Changes |
|------|---------|
| `src/repl.ts` | Add `PasteAwareStream` class, `handleLine()`, `handleSigint()`. Modify `startRepl()` to create stream, use it as readline input, wire paste-aware line handler and SIGINT handler. Make shutdown idempotent. Sanitize local echo for pasted content. |
| `tests/repl/paste.test.ts` | New test file for paste state management and PasteAwareStream behavior. |

### Not changed

- `handleCommand`, `parseCommand`, `pollTick`, `formatMessage` — no changes needed
- `src/channel.ts`, `src/modules/messaging/tools.ts` — not affected
- Send mode (`bun run src/repl.ts send ...`) — non-interactive, no paste support

## Edge cases

- **Unsupported terminal**: If terminal doesn't support bracketed paste, the escape sequences are silently ignored. Pasted text arrives as normal keystrokes — each line sends individually (current behavior). Graceful degradation.
- **Paste with no trailing newline**: Final line stays in `rl.line` until Enter. State machine step 2 appends it before sending.
- **Empty paste** (`\x1b[200~\x1b[201~`): No content buffered, no-op. Next Enter passes through normally.
- **Repeated paste before Enter**: Subsequent pastes before pressing Enter append to the existing `pasteBuffer`. The stream resets its own internal chunk buffer on each new paste start, but the line handler does NOT clear `pasteBuffer` — new lines are added to whatever was already buffered. This is simpler and more predictable than "latest paste wins" (which would also need to clear `rl.line`). Users can Ctrl+C to discard and start over.
- **Slash commands in pasted content**: Not interpreted. Pasted content containing `/help` is sent as message text, not executed as a command.
- **Markers split across chunks**: PasteAwareStream processes each chunk independently. If a marker is split across chunks (e.g., `\x1b[200` in one chunk, `~` in the next), the marker won't be detected and raw escape fragments may leak through to readline/message content. This is a known limitation — extremely rare in practice as terminals send paste sequences atomically.

## Tests

### PasteAwareStream unit tests

- Push data through unchanged when no paste markers present
- Strip paste start marker from output
- Strip paste end marker from output
- Buffer content during paste (between start and end markers)
- Push buffered content on paste end
- `isPasting` is true during paste, false after
- Handle start and end in same chunk
- Handle paste spanning multiple chunks
- Content before paste start is pushed immediately
- Content after paste end is pushed immediately
- Empty paste produces no push
- Repeated paste resets buffer
- Proxy `isTTY` from source

### Line handler tests

- Buffer lines while isPasting is true
- Send buffered content on Enter after paste ends (trailing newline case)
- Append non-empty line to buffer before sending (no trailing newline case)
- Pass through normal typed input
- Slash commands in paste are buffered, not interpreted
- Empty line with no pending paste passes through

### SIGINT tests

- Discard paste buffer on Ctrl+C during pending paste
- Discard during active paste (isPasting true)
- Ctrl+C cancels single-line paste (pasteSeen true, pasteBuffer empty)
- Return false (exit) when no paste active

### Content preservation tests

- Pasted content with leading whitespace is preserved (not trimmed)
- Pasted content with blank lines is preserved
- Pasted content local echo passes through sanitize()

### Shutdown tests

- Idempotent shutdown (calling twice does not error)
- PasteAwareStream._destroy() unregisters source listeners

### Regression tests

- Single typed line still sends immediately
- Slash commands still work when typed normally
- Ctrl+C exits when no paste is pending

## Known limitations

1. **Markers split across chunks**: The escape-sequence parser uses `indexOf()` on each chunk independently. If `\x1b[200~` or `\x1b[201~` is split across two `data` events, the marker is not detected and raw escape fragments leak through to readline/message content. Terminals send paste sequences atomically in practice, so this is extremely rare. A proper fix would require an incremental state machine carrying partial marker state across chunks; not worth the complexity for v1.

2. **Paste requires Enter to confirm**: Multi-line pastes that end with a trailing newline remain pending (`pasteSeen=true`) until the user presses Enter again. This is by design — the state machine treats Enter as an explicit confirmation to send. The alternative (auto-send on `PASTE_END`) would remove the user's ability to review pasted content before sending. The UX contract is: paste buffers, Enter confirms, Ctrl+C discards.

3. **Trailing newline not included in sent content**: When pasted content ends with `\n`, readline splits it into lines and the final empty string from Enter is treated as the send trigger, not as content to append (`if (line)` guard in `handleLine`). Interior blank lines are preserved; only the terminal newline is dropped. This matches how readline works — the `\n` is a line separator, not payload.

4. **Terminal cleanup on abnormal exit**: Bracketed paste mode is enabled at startup (`\x1b[?2004h`) and disabled in the `shutdown()` function (`\x1b[?2004l`). A crash, `SIGTERM`, or uncaught exception bypasses `shutdown()` and can leave the user's terminal in bracketed paste mode. A future improvement could register a `SIGTERM` handler or use `process.on("exit")` as a last-resort cleanup.
