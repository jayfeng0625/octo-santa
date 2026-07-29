# MCP SDK v2 Upgrade — Stateless Serving

**Date:** 2026-07-29
**Status:** Implemented

## Background

The MCP TypeScript SDK v2 (stable `2.0.0`, released alongside protocol revision
2026-07-28) replaces the monolithic `@modelcontextprotocol/sdk` with focused
packages and makes the protocol stateless. This spec records what was verified
empirically against the installed `@modelcontextprotocol/server@2.0.0` package
and the official docs, and the decisions applied to octo-santa.

## What changed in MCP v2 / revision 2026-07-28

- **Package split.** `@modelcontextprotocol/sdk` → `@modelcontextprotocol/server`
  (servers), `/client`, `/core` (schemas), plus framework adapters. Requires
  zod `^4.2.0` (zod 3 dropped) and Node 20+ (Bun fine).
- **Stateless protocol.** The `initialize` handshake and protocol-level sessions
  are gone on 2026-07-28 connections. Requests are self-contained; identity
  flows per-request in `_meta` envelopes. Server→client JSON-RPC requests are
  removed (sampling/elicitation/roots become `input_required` multi-round-trip
  results); `sendLoggingMessage` is deprecated.
- **Factory-based serving.** `serveStdio(factory)` from
  `@modelcontextprotocol/server/stdio` owns the transport and the era decision:
  it calls the factory when the connection's opening message arrives, pins ONE
  fresh instance per connection, and serves 2025-era (legacy `initialize`)
  and 2026-07-28 (modern) clients from the same factory. A `server/discover`
  probe instance may be built and discarded.
- **Notifications are opt-in on modern connections** — for spec-defined change
  notifications. Clients open `subscriptions/listen` streams; the stdio entry's
  listen router gates exactly four methods (`notifications/tools/list_changed`,
  `prompts/list_changed`, `resources/list_changed`, `resources/updated`).
  **Verified in the SDK source:** any other outbound notification method
  returns `'passthrough'` from the router and is written to the wire as-is on
  both eras, and `assertNotificationCapability` has no default-case check for
  custom methods. Custom extension notifications are explicitly era-blind.
- **API compatibility.** `McpServer`, `registerTool(name, config, cb)`,
  `ServerOptions.instructions`, `capabilities.experimental`, low-level
  `server.notification()`, `Server.oninitialized` and `Protocol.onclose` all
  survive. Raw-shape `inputSchema` records are deprecated in favor of
  `z.object({...})`. Tool callbacks receive `(args, ctx)` where `ctx` replaces
  v1's `extra`.

## Decisions

1. **Depend on `@modelcontextprotocol/server` `^2.0.0`; drop
   `@modelcontextprotocol/sdk`.** Only `src/transports/mcp-stdio/` touches it
   (hexagonal boundary unchanged; the boundary tests match any
   `@modelcontextprotocol/*` import).
2. **Serve via `serveStdio(factory)`.** `startMcpStdio()` becomes synchronous
   and returns the `StdioServerHandle`. The factory builds a fresh `McpServer`
   per connection; all per-connection state (agent binding, poller, heartbeat)
   lives in the factory closure. Nothing binds on a discarded probe instance
   because binding only happens on a committed tool call.
3. **Keep `notifications/claude/channel` push unchanged.** It is a custom
   extension notification, verified passthrough on both eras. Push stays
   best-effort; `messaging_read_messages` (SQLite poll) remains the fallback;
   SQLite persistence remains the delivery invariant.
4. **Tool requests stay self-contained.** Every mutating tool already takes
   `agent_id` explicitly — exactly the stateless per-request model. The
   per-connection binding is not protocol session state: it is the push/liveness
   lifecycle (which agent this process's poller and heartbeat serve), inherent
   to the one-agent-per-process deployment model.
5. **Bootstrap nudge is era-aware.** 2025-era connections get the bootstrap
   `notifications/claude/channel` once the initialize handshake completes
   (`oninitialized` — strictly better timing than v1's fire-after-connect).
   2026-07-28 connections have no handshake and no expectation of unsolicited
   pre-request notifications; they receive the same guidance as server
   `instructions`, served through `server/discover`.
6. **Schemas wrapped in `z.object()`** to move off the deprecated raw-shape
   registration form. Existing zod `^4.3.6` already satisfies the SDK's
   `^4.2.0` requirement.

## Non-changes

- Core, storage, and notification adapters are untouched — the upgrade is
  confined to the transport adapter, composition root, and docs.
- `registerMessagingTools(server, messaging, onAgentId)` keeps its signature,
  so binding-enforcement tests drive it unchanged.
- The SQLite watcher → MCP channel push design is unchanged (see
  2026-04-10-cross-process-notification-poller.md).

## References (validated 2026-07-29)

- https://ts.sdk.modelcontextprotocol.io/v2/ — SDK v2 docs
- https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2 — v1→v2 guide
- https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28 — protocol revision guide
- https://blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/ — spec/SDK announcement
- `@modelcontextprotocol/server@2.0.0` dist sources (`serveStdio`, listen
  router, capability assertions) — inspected directly in `node_modules`.
