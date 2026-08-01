# Admin Plane: Code-Mode TypeScript Access over a Separate MCP Connection

**Date:** 2026-08-01
**Status:** Implemented
**Builds on:** 2026-04-04-hexagonal-architecture-design.md, 2026-07-30-structured-tool-output.md

## What

An elevated integration surface for approved 1st/3rd-party apps that work with
octo-santa programmatically, without going through the chat-style messaging
tools. It is served on a **separate MCP connection** (its own entrypoint,
`src/admin.ts`, its own server identity `octo-santa-admin`) and exposes exactly
two generic tools in the **code-mode / programmatic-tool-calling** style — the
tools run **TypeScript**, not queries:

- `admin_search` — runs submitted code with each module's **read-only** API bound
- `admin_execute` — runs submitted code with each module's **full** API bound

Prior art this follows: Cloudflare Code Mode (tools exposed as a typed API the
model writes code against, one code-execution tool instead of many), Anthropic
programmatic tool calling (Claude writes code that calls tools in a code
container, filtering/aggregating before results reach context), and
`mksglu/context-mode` (sandboxed execution where only the returned value
enters context).

Submitted code is the body of an async function: it may `await`, and it
`return`s a JSON-serializable value. That value, plus captured `console`
output, is the tool result — so a client can look up state, act, filter, and
aggregate all in one round trip, returning only what it needs.

**Modules never expose their raw backend.** Each module contributes a typed API
object bound as a global inside the code, plus a TypeScript `.d.ts` fragment
(its *typehead*) describing that API. The SQLite storage module exposes
controlled methods like `postMessage` and `countMessages` — **no raw SQL
crosses the boundary**. Core composes the module fragments with an
execution-model header into the single `.d.ts` served as MCP resource
`octo-santa://admin/typehead.d.ts`. Clients read it once and have a typed,
compile-time contract for everything the two tools can do.

## Why

Two driving use cases:

1. **External agent loops.** A bridge process listens for issue-tracker
   webhooks (Linear, Notion, Jira). On a change event it decides which channels
   and agents to target and delivers directly. `storage.postMessage(...)` writes
   to the shared database, and because every agent process watches the
   `messages` table, that write **is** a push delivery — no other signal exists
   or is needed.
2. **OLAP-style analytics.** `storage.countMessages({ groupBy: ... })` and
   filtered `getMessages` scans over message history, reshaped in code, without
   consuming any agent's unread cursor.

Both need more than the messaging tools allow (they bypass membership checks,
registration, cursor semantics) and are better served by controlled methods
than by either a bespoke tool per operation or raw SQL. Two code-mode tools + a
per-module typehead give infinite extensibility with a fixed tool surface,
while keeping the dangerous surface (raw SQL, file handles, wire protocols)
hidden behind methods that uphold the system's invariants.

## Why not raw SQL (the earlier iteration)

The first cut exposed `admin_search`/`admin_execute` as raw SQL with a typehead
that documented the table schema. It was rejected: it leaks the storage
implementation into the contract, makes every invariant (FK ordering, mention
extraction, membership-on-send, DM privacy) the caller's problem, and can't
generalize — a future non-SQL module has no "dialect" to expose. Code-mode over
controlled methods fixes all three: the backend stays hidden, invariants live
in the module, and core only knows "run TypeScript with these globals bound."

## Architecture

Hexagonal placement — core stays agnostic about both the language runtime and
what any module's methods do:

```
core/admin/types.ts        AdminModuleDescription, CodeRunOutcome, AdminRunResult, ...
core/ports.ts              AdminModulePort { describe, createSearchApi, createExecuteApi }
                           CodeRunnerPort  { run(code, bindings) }
core/admin/service.ts      AdminService — composes bindings + typehead, normalizes result
runtime/typescript/
  runner.ts                TypeScriptRunner implements CodeRunnerPort
storage/sqlite/
  admin-module.ts          SqliteAdminModule implements AdminModulePort (controlled methods)
  admin-typehead.ts        STORAGE_TYPEHEAD — the module's .d.ts fragment
transports/mcp-admin-stdio/
  adapter.ts               admin_search + admin_execute tools, typehead resource
  schemas.ts               RunOutput wire schema (satisfies-checked against core types)
admin.ts                   composition root for the admin connection
```

- **Core** (`AdminService`): agnostic. For a run it collects each module's API
  (read-only for `search`, full for `execute`) into a `bindings` map keyed by
  module name, hands `(code, bindings)` to the `CodeRunnerPort`, and normalizes
  the outcome — `undefined` → `null`, and a JSON round-trip that turns cycles /
  bigints / functions into a clear error at the boundary. `describe()` composes
  the served `.d.ts` from an execution-model header (core owns it) plus each
  module's fragment. Duplicate and reserved (`console`) module names are
  rejected at construction. Neither port is shaped by SQLite or by TypeScript
  specifically — a different runtime or a non-storage module drops in unchanged.
- **Runtime** (`TypeScriptRunner`, a new adapter layer): transpiles with
  `Bun.Transpiler` (types stripped), rejects `import` / `require` / dynamic
  `import()` up front via `scanImports`, wraps the code as an async function
  body, and runs it in an `AsyncFunction` with the module globals + a `console`
  shim bound and the host ambient identifiers (`process`, `Bun`, `require`,
  `module`, `exports`) shadowed to `undefined`. A timeout guards hung awaits.
  This is **hygiene, not a security sandbox** — code runs in-process and
  `globalThis` remains reachable; the real trust boundary is who can launch the
  admin entrypoint at all. The hygiene makes integrations fail loudly when they
  reach outside their typed surface.
- **Storage module** (`SqliteAdminModule`): the `storage` global. Exposes a
  read surface (`listAgents`, `getMessages`, `countMessages`,
  `getMaxMessageId`, ...) and, on execute, controlled writes (`ensureAgent`,
  `ensureChannel`, `addMember`, `postMessage`, `postDirectMessage`). Each write
  reuses the same domain rules the messaging service enforces (agent-name
  validation, `extractMentions`, no self-mention, DM privacy via
  `assertDmAccess`, membership-on-send) and the same concurrency discipline
  (`db.query()` cached statements, `.immediate()` transactions wrapped in
  `withRetrySync`). The read API is a strict subset of the write API object, so
  `admin_search` literally cannot mutate — the write methods are absent from
  its binding.
- **Transport** (`mcp-admin-stdio`): a second stdio adapter, stateless (no
  agent binding, poller, or heartbeat). Both tools take a single `code` string;
  results follow the structured-output contract (top-level object,
  `text === JSON.stringify(structuredContent)`). `admin_execute` carries
  `destructiveHint: true`.
- **Typehead as a resource, not a tool.** Keeping the tool surface at exactly
  search + execute is the point; the typed contract is static reference
  material, so it lives on the resource surface.

## Extensibility: adding a module

A new module implements `AdminModulePort` — `describe()` returning its binding
name, provider, and `.d.ts` fragment; `createSearchApi()` / `createExecuteApi()`
returning the API objects — and is passed into `AdminService`'s module list at
the composition root. Its methods appear as a new global inside submitted code,
its fragment is concatenated into the served `.d.ts`, and core, the runtime,
and the transport are untouched. Different modules may have entirely different
interaction patterns; core only composes them.

## Separate connection, elevated trust

The admin plane is a different MCP server (`octo-santa-admin`) with a different
entrypoint. "Approved" is enforced the local-first way: only whoever configures
the MCP client to launch `src/admin.ts` (or `dist/<version>/admin.js`) gets the
plane — the same trust boundary as file access to `messages.db` itself, with no
accounts or network exposure added. The messaging connection never gains these
tools; agent-facing sessions cannot reach the elevated surface.

## Invariants (upheld inside the module, documented in the typehead)

- Posting a message *is* delivery: every agent process watches the `messages`
  table and pushes matching rows. `mentions` drives targeting (`["*"]` = @all;
  DM channels always push; `[]` = silent). Callers never see the FK ordering
  or mention-extraction — `postMessage`/`postDirectMessage` handle it.
- Reads never advance any unread cursor.
- Message ids are monotonic; `getMaxMessageId` + `getMessages({ afterId })`
  form the incremental-pull cursor for external loops.

## Testing

- `tests/hex/core/admin-service.test.ts` — agnostic composition: correct
  read/full binding per tool, typehead assembly, duplicate/reserved-name
  guards, result normalization (fake runner + fake modules).
- `tests/hex/runtime/typescript-runner.test.ts` — TS execution, awaited
  bindings, console capture, import/require rejection, identifier shadowing,
  error/syntax/timeout handling.
- `tests/hex/storage/admin-module.test.ts` — the controlled API: exact
  read/write method sets (no raw SQL), invariant enforcement, aggregation, and
  a **typehead drift guard** asserting every API method is declared in the
  `.d.ts`.
- `tests/hex/transports/admin-tool-metadata.test.ts` — exactly two tools, both
  taking `code`, annotations, structured-output contract, composed typehead
  resource, <2KB instructions.
- `tests/admin/external-integration.test.ts` — end-to-end: an issue-tracker
  bridge's `postMessage` (submitted as TypeScript) is seen by
  `messaging_read_messages` and the notification watcher; the read surface has
  no write methods; OLAP aggregation and incremental-pull loops run in code and
  leave cursors untouched.
- `tests/architecture/hexagonal-boundaries.test.ts` — the new `runtime` layer
  depends only on core and no other adapter depends on it.
