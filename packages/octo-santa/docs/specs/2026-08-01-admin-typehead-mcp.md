# Admin Plane: Code-Mode TypeScript Access over a Separate MCP Connection

**Date:** 2026-08-01
**Status:** Implemented
**Builds on:** 2026-04-04-hexagonal-architecture-design.md, 2026-07-30-structured-tool-output.md

## What

An elevated integration surface for approved 1st/3rd-party apps that work with
octo-santa programmatically, without going through the chat-style messaging
tools. It is served on a **separate MCP connection** (its own entrypoint,
`src/admin.ts`, its own server identity `octo-santa-admin`) and exposes exactly
two generic tools in the **code-mode / programmatic-tool-calling** style:

- `admin_search` — **discovery**: searches the modules' typed declarations by
  keyword and returns the matching methods and types with their docs, so an
  agent pulls only the definitions it needs into context
- `admin_execute` — **the only operation that runs code**: executes submitted
  TypeScript with every module's API bound as a global

Prior art this follows: Cloudflare Code Mode, whose whole surface is the same
`search()` + `execute()` pair — search for progressive disclosure over a large
API (filter thousands of endpoints down to the handful needed, without the
full spec ever entering the context window), execute for running composed
code in a sandbox; Anthropic programmatic tool calling (Claude writes code
that calls tools in a code container, filtering/aggregating before results
reach context, with tool definitions discovered on demand rather than loaded
up front); and `mksglu/context-mode` (sandboxed execution where only the
returned value enters context, plus ranked search over indexed content).

The flow an integrating agent follows: **search for what it wants to do →
read the declarations that come back → execute code that calls them.**

Submitted code is the body of an async function: it may `await`, and it
`return`s a JSON-serializable value. That value, plus captured `console`
output, is the tool result — so a client can look up state, act, filter, and
aggregate all in one round trip, returning only what it needs.

**Modules never expose their raw backend.** Each module contributes a typed API
object bound as a global inside the code, plus a TypeScript `.d.ts` fragment
(its *typehead*) describing that API. The SQLite storage module exposes
controlled methods like `sendMessage` and `countMessages` — **no raw SQL
crosses the boundary**. The typehead is what `admin_search` searches: core
chunks each fragment into declarations (members with their docs, interfaces,
the module overview) and serves keyword-ranked matches. The full composed
`.d.ts` also remains readable as MCP resource
`octo-santa://admin/typehead.d.ts` for clients that want the whole contract
up front — e.g. to typecheck an integration against.

## Why

Two driving use cases:

1. **External agent loops.** A bridge process listens for issue-tracker
   webhooks (Linear, Notion, Jira). On a change event it decides which channels
   and agents to target and delivers directly. `storage.sendMessage(...)` writes
   to the shared database, and because every agent process watches the
   `messages` table, that write **is** a push delivery — no other signal exists
   or is needed.
2. **Reporting over history.** `storage.countMessages({ group_by: ... })` and
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
core/admin/types.ts        AdminModuleDescription, CodeRunResult, AdminRunResult, JsonValue
core/admin/typehead-index.ts  TypeheadIndex — chunks .d.ts fragments, keyword-ranked search
core/ports.ts              AdminModulePort { describe, createApi }
                           CodeRunnerPort  { language, reservedNames, run(code, bindings) }
core/admin/service.ts      AdminService — search over the index; execute via the runner
runtime/typescript/
  runner.ts                TypeScriptRunner implements CodeRunnerPort
storage/sqlite/
  admin-module.ts          SqliteAdminModule implements AdminModulePort (controlled methods)
  admin-typehead.ts        STORAGE_TYPEHEAD — the module's .d.ts fragment
transports/mcp-admin-stdio/
  adapter.ts               admin_search + admin_execute tools, typehead resource
  schemas.ts               SearchOutput / ExecuteOutput wire schemas
admin.ts                   composition root for the admin connection
```

- **Core** (`AdminService`): agnostic. `search(query)` runs over a
  `TypeheadIndex` built once at construction — module fragments chunked into
  declaration entries, scored by keyword (name hits over body hits, with a
  bonus when the query covers a name completely), capped with a reported
  pre-limit total. `execute(code)` collects each module's `createApi()` into
  a `bindings` map keyed by module name, hands `(code, bindings)` to the
  `CodeRunnerPort`, and normalizes the outcome — `undefined` → `null`, and a
  JSON round-trip that turns cycles / bigints / functions into a clear error
  at the boundary. `describe()` composes
  the served `.d.ts` from an execution-model header (core owns it) plus each
  module's fragment, once at construction. Duplicate module names, and names
  the runner reserves (`console`, `process`, ...), are rejected there too —
  the reserved list lives on `CodeRunnerPort`, the layer that owns the
  execution environment, so a misconfiguration fails at boot rather than on
  every request. Core's header deliberately does not name the MCP tools: it
  describes the search and execute operations, and the transport appends the
  `admin_search`/`admin_execute` mapping when it serves the document.
  Neither port is shaped by SQLite or by TypeScript specifically — a different
  runtime or a non-storage module drops in unchanged, and `CodeRunnerPort`
  reports its own `language`.
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
- **Storage module** (`SqliteAdminModule`): the `storage` global — one
  `StorageApi` with reading methods (`listAgents`, `getMessages`,
  `countMessages`, `getLatestMessageId`, ...) and controlled writes
  (`createAgentIfMissing`, `createChannelIfMissing`, `addMember`,
  `sendMessage`, `sendDirectMessage`). Each write reuses the same domain rules
  the messaging service enforces (agent-name validation, `extractMentions`,
  no self-mention, DM privacy via `assertDmAccess`, membership-on-send) and
  the same concurrency discipline (`db.query()` cached statements,
  `.immediate()` transactions wrapped in `withRetrySync`). Safety comes from
  the methods themselves — every one is a parameterized operation that
  upholds the invariants, so there is no raw surface for code to misuse.
- **Transport** (`mcp-admin-stdio`): a second stdio adapter, stateless (no
  agent binding, poller, or heartbeat). `admin_search` takes `{query, limit?}`
  and is `readOnlyHint: true`; `admin_execute` takes `{code}` and carries
  `destructiveHint: true`. Results follow the structured-output contract
  (top-level object, `text === JSON.stringify(structuredContent)`).
- **The full typehead stays a resource.** `admin_search` is the progressive
  path; the resource serves the whole contract up front for clients that
  want it.

### Naming

The tool names `admin_search` / `admin_execute` mirror Code Mode's
`search()` / `execute()` pair — search is discovery over the declarations,
execute runs the code. The method surface is written for an outside
integrator, not for this codebase: `sendMessage` / `sendDirectMessage`
(matching the product's `send` verb, and avoiding the DOM's `postMessage`),
`createAgentIfMissing` / `createChannelIfMissing` (saying what they do
instead of "ensure"), one `StorageApi` interface, `getLatestMessageId`, and
snake_case options (`after_id`, `since_ms`, `group_by`) matching the existing
`before_id`. The typehead prose avoids jargon — no "OLAP", no "high-water
mark" — and explains the incremental-pull pattern in plain words instead.

## Extensibility: adding a module

A new module implements `AdminModulePort` — `describe()` returning its binding
name, provider, and `.d.ts` fragment; `createApi()` returning the API
object — and is passed into `AdminService`'s module list at
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
  or mention-extraction — `sendMessage`/`sendDirectMessage` handle it.
- Reads never advance any unread cursor.
- Message ids are monotonic; `getLatestMessageId` + `getMessages({ after_id })`
  form the incremental-pull cursor for external loops.

## Testing

- `tests/hex/core/admin-service.test.ts` — agnostic composition: search finds
  declarations across modules without touching the runner, execute binds every
  module's API, typehead assembly, duplicate/reserved-name guards, result
  normalization (fake runner + fake modules).
- `tests/hex/core/typehead-search.test.ts` — the discovery index: chunking
  (members with docs, interfaces, overview), ranking (names over bodies,
  whole-name coverage), limits — proven on both a synthetic fragment and the
  real storage fragment, where every `StorageApi` method must be findable by
  its own name and plain-word queries.
- `tests/hex/runtime/typescript-runner.test.ts` — TS execution, awaited
  bindings, console capture, import/require rejection, identifier shadowing,
  error/syntax/timeout handling.
- `tests/hex/storage/admin-module.test.ts` — the controlled API: exact method
  set (no raw SQL, no internals), invariant enforcement, aggregation, and a
  **typehead drift guard** asserting the `.d.ts` declares exactly the methods
  the API implements.
- `tests/hex/transports/admin-tool-metadata.test.ts` — exactly two tools:
  search takes `{query, limit?}`, execute takes `{code}`; annotations,
  structured-output contract, composed typehead resource, <2KB instructions.
- `tests/admin/external-integration.test.ts` — end-to-end: an issue-tracker
  bridge searches for "send message to a channel", reads the returned
  declaration, then executes code whose write is seen by
  `messaging_read_messages` and the notification watcher; reporting and
  incremental-pull loops run in code and leave cursors untouched.
- `tests/architecture/hexagonal-boundaries.test.ts` — the new `runtime` layer
  depends only on core and no other adapter depends on it.
