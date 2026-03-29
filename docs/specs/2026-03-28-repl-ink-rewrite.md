# REPL Ink Rewrite

Extract the REPL into `src/repl/` and rewrite the interactive UI with Ink (React for terminals).

## Motivation

The current `src/repl.ts` (609 lines) is a monolith using Node's `readline`. It can't support multiline input because readline operates in cooked mode — Enter always submits, and modifier keys (Shift+Enter) are invisible. Modern CLI tools (Claude Code, opencode) solve this with raw mode key detection. Ink gives us raw mode, React's component model, and terminal rendering without reimplementing line editing from scratch.

## Directory Structure

```
src/
  repl/
    index.ts            — entry point (main + arg routing)
    app.tsx             — Ink <App> root component
    components/
      text-input.tsx    — multiline input with Shift+Enter support
      message-log.tsx   — scrolling message display
    commands.ts         — parseCommand + handleCommand (extracted from repl.ts)
    args.ts             — parseArgs (extracted from repl.ts)
    send.ts             — runSendMode (extracted from repl.ts, no Ink)
    poll.ts             — pollTick logic (extracted from repl.ts)
    display.ts          — sanitize, formatMessage (extracted from repl.ts)
```

`src/repl/` is a top-level directory — not inside `src/modules/`. The REPL doesn't implement `OctoModule` (no MCP tools to register). It imports directly from `src/modules/messaging/tools.ts`, same as today.

## Build Separation

Bun's bundler tree-shakes by entry point. `build:mcp` starts from `src/mcp.ts` and never reaches Ink/React imports. `build:repl` starts from `src/repl/index.ts` and compiles into a standalone binary (`ocr`). No build config changes needed beyond updating the entry point path.

`scripts/build.ts` and `package.json` scripts updated to reference `src/repl/index.ts`.

## Component Architecture

### `<App>` (app.tsx)

Root component. Owns all state:

- `messages: {channel, agent, content, id}[]` — the scrolling log
- `activeChannel: string` — current channel name
- `cursors: Map<string, number>` — per-channel read position

Receives `db: Database`, `agentId: string`, and `initialChannel: string` as props (created in `index.ts` before `render()`).

Runs a poll timer via `useEffect` interval — calls `pollTick()`, appends new messages to state. Handles slash command dispatch by calling `handleCommand()`, which returns display strings or state mutations.

### `<MessageLog>` (message-log.tsx)

Pure display component. Receives `messages[]` as props. Renders each as `<Text>` with sanitization. No state, no side effects.

### `<TextInput>` (text-input.tsx)

Multiline input component with Kitty keyboard protocol support:

- Manages its own buffer and cursor position
- Enter → calls `onSubmit(value)`
- Shift+Enter → inserts newline into buffer
- Renders current input with prompt prefix (`channel> `)
- Grows vertically when input contains newlines
- Backspace across newline boundary joins lines
- Up/Down arrows move between lines when multiline
- Ctrl+C → exit

## Multiline Input & Key Detection

### Kitty Keyboard Protocol

On startup, write `\x1b[>1u` to stdout to enable the Kitty keyboard protocol. On exit, write `\x1b[<u` to restore. Shift+Enter arrives as `\x1b[13;2u` — detected in the raw stdin handler.

Supported terminals: Kitty, WezTerm, Ghostty, iTerm2, Windows Terminal.

Fallback for terminals without Kitty support: Enter always submits (same behavior as the current readline REPL, no regression).

### No Command History

No up-arrow history for now. Keeps the `<TextInput>` component focused. Can be added later.

## Slash Commands

All existing commands carry over unchanged:

- `/channels` — list channels
- `/agents` — list agents
- `/join <channel>` — switch to channel
- `/create <channel>` — create a channel
- `/history [N]` — show recent messages
- `/send -f <path>` — send file contents
- `/members` — list channel members
- `/help` — show help
- `/quit` — exit

Command parsing and handling are pure functions in `commands.ts` — no Ink dependency. `handleCommand()` is refactored to return a result object (`{output: string[], channelChange?: string}`) instead of accepting a `printAbove` callback. The `<App>` component interprets the result to update state and append output to the message log.

## Send Mode

`bun repl send -f file.txt --as agent -c channel` reads stdin or a file, calls `sendMessage()`, prints the message ID, and exits. No Ink involved — this is a simple script path in `index.ts`.

## Migration from Current repl.ts

### Extracted as-is (pure logic, updated imports):
- `parseArgs()` → `args.ts`
- `parseCommand()`, `handleCommand()` → `commands.ts`
- `sanitize()`, `formatMessage()` → `display.ts`
- `pollTick()` → `poll.ts`
- `runSendMode()` → `send.ts`

### Dropped (replaced by Ink):
- `PasteAwareStream` class — Ink's raw mode replaces bracketed paste detection
- `handleLine()`, `handleSigint()` — paste-aware state machine no longer needed
- `startRepl()` — replaced by `<App>` component
- All readline usage

### Deleted:
- `src/repl.ts` — replaced entirely by `src/repl/`

## Dependencies

### Added (runtime):
- `ink`
- `react`

### Added (dev):
- `ink-testing-library`

### Unchanged:
- `@modelcontextprotocol/sdk`, `zod` — MCP-only, not touched

## Testing

### Carried over (updated import paths):
- `tests/repl/args.test.ts` — argument parsing
- `tests/repl/commands.test.ts` — slash command handling
- `tests/repl/display.test.ts` — message formatting, sanitize
- `tests/repl/poll.test.ts` — background poll logic
- `tests/repl/send.test.ts` — send mode

### Deleted:
- `tests/repl/paste.test.ts` — bracketed paste no longer exists

### New:
- `tests/repl/text-input.test.tsx` — render `<TextInput>`, simulate keystrokes (Enter, Shift+Enter, backspace across newlines), assert output via `ink-testing-library`
- `tests/repl/app.test.tsx` — render `<App>` with in-memory DB, send a message, verify it appears in the message log

### Updated:
- `tests/repl/integration.test.ts` — rewritten to test via Ink rendering instead of readline simulation
- `tests/repl/cli.test.ts` — updated entry point path
