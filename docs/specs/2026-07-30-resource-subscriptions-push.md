# Spec-Native Push via MCP Resources + subscriptions/listen

**Date:** 2026-07-30
**Status:** Implemented 2026-07-31 (all five recommendation items; open questions
remain deferred)

**Implementation deltas from the prototype appendix:**

- Unknown-channel reads map to the SDK's `ResourceNotFoundError` (wire
  `-32602` + `data.uri`) via a typed `ChannelNotFoundError` thrown by
  `MessagingService.readHistory` — the adapter maps the domain error instead
  of parsing message strings (recommendation 3). Malformed percent-encoding
  in the `{channel}` variable maps to the same error instead of `-32603`.
- The per-connection port construction is extracted as
  `createConnectionNotificationPort(mcpServer, era)` so era gating and the
  first-seen `list_changed` dedup are unit-testable.
- Clarified semantics: the poller query excludes the bound agent's own
  messages, so `resources/updated` fires for all *other* senders' messages —
  an agent is never pinged for its own sends (documented in instructions).

## Background

octo-santa's push channel today is the custom `notifications/claude/channel`
extension notification: each agent's server process polls the shared SQLite
file (2s watcher, adapter-owned HWM) and pushes mention/DM-filtered messages
to its bound agent. It is Claude-specific, transport-specific (stdio only),
and invisible to standard MCP clients. Poll fallback is
`messaging_read_messages`; SQLite persistence is the delivery invariant.

Protocol revision 2026-07-28 (SDK v2, `@modelcontextprotocol/server@2.0.0` —
already adopted on this branch) offers a standards-native alternative:

- **Resources**: a server exposes addressable, readable documents
  (`resources/list`, `resources/templates/list`, `resources/read`).
- **Opt-in change notifications**: a modern client opens a
  `subscriptions/listen` stream with a filter
  `{toolsListChanged?, promptsListChanged?, resourcesListChanged?,
  resourceSubscriptions?: string[]}`. The stdio entry's listen router
  (`StdioListenRouter`) acks with `notifications/subscriptions/acknowledged`
  (the filter narrowed against the server's *declared* capabilities), then
  routes exactly four outbound methods onto subscribed streams —
  `notifications/{tools,prompts,resources}/list_changed` and
  `notifications/resources/updated` (per-URI, exact string match) — each
  stamped with `_meta["io.modelcontextprotocol/subscriptionId"]`. Everything
  else, including our custom notification, is passthrough on both eras.
- The 2025-era `resources/subscribe`/`resources/unsubscribe` requests were
  **removed** from the 2026-07-28 wire registry; on the legacy path SDK v2
  keeps them in the 2025 registry but registers **no handler** (verified:
  `-32601 Method not found`).

This spec models channel history as MCP resources and maps the existing
SQLite watcher onto `notifications/resources/updated`, giving any
spec-compliant 2026-07-28 client wake-up pings without octo-santa's custom
vocabulary. It is a **sibling** to the custom push, not a replacement.

## Design

### Resources model and URI scheme

One resource template registered on every connection server:

```
octo-santa://channels/{channel}/messages
```

- **Canonical URI**: `octo-santa://channels/<encodeURIComponent(name)>/messages`,
  minted only by a single helper `channelResourceUri(name)`. Channel names
  allow `[\w.,@#-]`; `#` starts a URI fragment, and the SDK's `UriTemplate`
  `{var}` match regex is `([^/,]+)` so a raw `,` (every DM channel name)
  would never match. Percent-encoding solves both; `UriTemplate.match()` does
  **not** decode, so the read callback applies `decodeURIComponent`.
  Because the listen router's per-URI filter is an **exact string
  comparison** (`resourceSubscriptions.includes(event.uri)`), every mint —
  list, read, updated-ping — must go through the one helper.
- **list callback** enumerates `MessagingService.listChannels()` (parity with
  the public `messaging_list_channels` tool, DM channels included — same
  pre-existing exposure).
- **resources/read** is a **pure history read**: it returns the newest 50
  messages (all senders, ascending) and never touches the unread cursor.
  This required a new seam — see below.

### New core seams (the port decision)

1. **`MessageRepository.readRecent(channelId, limit)`** (new port method,
   `src/core/ports.ts`) + SQLite implementation: transaction-free WAL read of
   the newest N messages. Neither existing read fit: `readForwardAndAdvance`
   consumes the cursor; `readBefore` requires a `beforeId` and excludes the
   reader's own messages (inbox semantics, wrong for a history document).
2. **`MessagingService.readHistory(agentId, channelName, limit)`**: same
   guards as `read()` (registered + `assertDmAccess` + membership) but pure.
3. **`NotificationPort.notifyChannelActivity?(channelName)`** — the update
   wiring. The poller (notification adapter) is the only component that sees
   cross-process message arrival; `sendResourceUpdated` lives in the
   transport. `NotificationPort` in `core/ports.ts` is the existing seam
   shared by exactly these two adapters, so it gains one **optional** method:
   fired at most once per tick per distinct channel with new messages,
   **regardless of mentions** (a resource subscriber asked for all activity,
   not just mentions; the mention filter stays on `notify()` only). The
   signal is deliberately domain-shaped — "this channel has activity", a
   channel *name*, not a URI or an MCP method — so the port serves core
   vocabulary and the resources mapping stays entirely inside the transport
   adapter. A second dedicated port was considered and rejected: same two
   adapters, same lifecycle, same wiring path through `startPoller(port,
   agentId)`; a second port would duplicate the plumbing for no decoupling
   gain. Being optional, non-MCP transports and existing tests are untouched.

### Update wiring

In the transport adapter's per-connection `NotificationPort`:

- `notifyChannelActivity(name)` → `server.sendResourceUpdated({ uri:
  channelResourceUri(name) })`. On modern connections the listen router
  delivers it only to subscriptions whose filter contains that exact URI,
  stamped with the subscription id; with no matching subscription it is
  dropped at the entry (verified — "the modern era never delivers an
  un-requested change type").
- **First-seen heuristic for `list_changed`**: when a channel produces
  activity this connection hasn't seen before, also emit
  `sendResourceListChanged()`. This piggybacks on the same seam — no new
  storage queries — and covers cross-process channel *creation* and *rename*
  organically, because both produce a message in the channel (rename posts an
  announcement message), which the poller surfaces under the new name.
  It does not cover silent channel creation (create with no message) —
  acceptable for a hint-grade notification; see Open questions.

### Capability declaration

```ts
capabilities: {
  experimental: { "claude/channel": {} },
  resources: { subscribe: true, listChanged: true },
}
```

Empirically verified requirements: `resources.subscribe: true` is mandatory
or the router's `honoredSubset` **strips `resourceSubscriptions` from the
ack** (silently — the client sees its URIs vanish from the honored filter).
`resources.listChanged: true` gates `resourcesListChanged` the same way.
Nothing auto-sets `subscribe`; declare it in the constructor options — the
entry hands `server.getCapabilities()` to the listen router immediately after
the factory returns (`connectInstance`), and `mergeCapabilities` preserves
the `subscribe` bit when `setResourceRequestHandlers` later merges its
`listChanged` default. (`tools.listChanged: true` is auto-set by
`registerTool`; prompts stay undeclared, so `promptsListChanged` is stripped
— all observed in the ack.)

### Era behavior

- **Modern (2026-07-28)**: full feature. `subscriptions/listen` requires the
  per-request `_meta` envelope. Multiple concurrent listen subscriptions per
  connection work (each keyed by its request id); `notifications/cancelled`
  tears one down.
- **Legacy (2025-era)**: **no spec push**. `resources/subscribe` is
  `-32601 Method not found` (SDK v2 serves no handler and offers no
  McpServer-level registration for it). Outbound change notifications are NOT
  routed on legacy — they would pass through **unsolicited and unstamped** to
  a client that never asked (verified) — so the adapter gates
  `notifyChannelActivity` emission to modern connections. Legacy keeps the
  custom `notifications/claude/channel` push unchanged. `resources/read`,
  `resources/list` do work on legacy (handlers are era-blind).
- **Both eras**: the custom push is passthrough and unchanged.

## Expected outcome

Clients gain:

- **Standards-native wake-ups**: any 2026-07-28 MCP client — not just Claude
  — can subscribe to a channel URI and receive `notifications/resources/updated`
  when the channel gains messages, with proper subscription-id stamping,
  without knowing octo-santa's custom vocabulary.
- **Unfiltered channel-activity signal**: pings for *all* new messages in
  subscribed channels, not only mentions/DMs (a superset of the custom push's
  triggering conditions, by client opt-in).
- **Pure history reads**: `resources/read` gives channel history without
  consuming the unread cursor — tooling/dashboards can inspect channels
  without eating an agent's inbox.
- **Discovery**: `resources/list` enumerates channels as first-class MCP
  resources.

Unchanged: the custom push (both eras), all messaging tools and their cursor
semantics, the poller cadence and HWM, SQLite as the only cross-process
bridge, delivery guarantees (spec push is best-effort exactly like the custom
push; persistence remains the invariant), and the one-agent-per-process
deployment model.

## Pros

- **Spec compliance with near-zero mechanism cost**: the SDK's listen router
  does subscription bookkeeping, filtering, stamping, and graceful teardown;
  the adapter only calls `sendResourceUpdated`. Same poller tick as the
  custom push — measured arrival delta **0.7ms** (see findings) — zero added
  latency.
- **Sound privacy by construction**: update pings can only describe channels
  the connection's bound agent is a member of, because the emitting poller
  query is membership-scoped and each process serves exactly one agent. A
  non-member subscribing to a guessable DM URI gets an ack echo but **zero
  pings ever** (verified cross-process), and `resources/read` enforces DM
  access + membership through the same service guards as the tools.
- **Coarse signal = cheap and race-free**: "channel changed, re-read if you
  care" carries no message content; no second cursor, no double-delivery
  concern with the custom push (independent HWM already exists).
- **Hexagonal boundaries intact**: one optional domain-shaped port method;
  core still knows nothing about MCP; storage gains a pure read; the arch
  test suite passes unmodified.
- **Modern-era drop semantics are free hygiene**: with no listen stream, spec
  pings vanish at the entry while the custom push still flows — no
  double-notification for current Claude clients.

## Cons

- **No legacy story at all**: 2025-era clients cannot get spec push —
  `resources/subscribe` is unserved by SDK v2, and honoring it ourselves
  would mean hand-registering the handler *and* hand-filtering per-URI in the
  adapter (the entry routes nothing on legacy). Feature is modern-only.
- **Capability advertisement wart**: the legacy `initialize` result
  advertises `resources: { subscribe: true }` (observed) — a capability the
  connection cannot serve. Fixable by declaring `subscribe` only on
  modern-era instances (factory receives the era).
- **Ack does not validate URIs**: the router honors any
  `resourceSubscriptions` entry verbatim — a non-member's subscription to a
  DM URI is *acknowledged* (observed). No data leaks (no pings, reads
  denied), but the ack falsely implies the subscription is live. A client
  cannot distinguish "valid but quiet channel" from "channel I'll never hear
  about". DM-privacy leakage in pings is structurally nil (membership-scoped
  poller, one agent per process); the residual exposure is channel *names*
  in `resources/list` — identical to the existing `messaging_list_channels`
  exposure, so nothing new leaks, but resources/list now re-states it in a
  second place to keep in mind if list semantics ever tighten.
- **Exact-match URI fragility**: subscription matching is byte-for-byte. Any
  client that builds the URI without percent-encoding (or encodes
  differently, e.g. lowercase hex) silently never matches. Channel renames
  silently orphan subscriptions to the old URI (mitigated, not solved, by the
  `list_changed` hint).
- **Unread-history asymmetry**: `resources/read` returns newest-50 of *all*
  messages including your own — deliberately a history document — but a
  client that treats it as an inbox will re-see read messages. Docs must be
  explicit that cursors belong to `messaging_read_messages` only.
- **Two push vocabularies to maintain**: mention-filtered content push
  (custom) and unfiltered activity ping (spec) coexist; instructions text
  must explain when to use which, inside a 2KB budget.

## Prototype findings

Prototype built in a throwaway worktree (diff summary below): resource
template + pure read path + poller channel-activity hook + capability
declaration. Smoke-tested end-to-end with real `bun run src/main.ts`
subprocesses sharing a temp SQLite DB (poll interval 200ms),
newline-delimited JSON-RPC over stdio, envelope-stamped modern clients and a
handshake legacy client. **All 33 checks across 4 scenarios passed.**

**Listen ack (verbatim)** — request id 3 becomes the subscription id; filter
honored verbatim because `resources.subscribe` was declared:

```json
{"jsonrpc":"2.0","method":"notifications/subscriptions/acknowledged","params":{"notifications":{"resourcesListChanged":true,"resourceSubscriptions":["octo-santa://channels/design.review/messages","octo-santa://channels/smoke-a%2Csmoke-b/messages"]},"_meta":{"io.modelcontextprotocol/subscriptionId":3}}}
```

**Updated notification (verbatim)** — emitted by agent A's poller after
agent B (separate OS process) posted to the channel:

```json
{"jsonrpc":"2.0","method":"notifications/resources/updated","params":{"uri":"octo-santa://channels/design.review/messages","_meta":{"io.modelcontextprotocol/subscriptionId":3}}}
```

**Latency vs custom push**: both notifications for the same message arrived
from the same poller tick, delta **0.7ms** (custom push first — the poller
loop notifies per-message before flushing the per-tick channel set).
End-to-end latency is bounded by the poll interval for both, i.e. identical.

**Cursor purity**: after receiving the ping, A's `resources/read` returned
the message; a subsequent `messaging_read_messages` **still returned it as
unread**; a second `messaging_read_messages` returned empty — proving
`resources/read` consumed nothing and the tool remains the only consumer.

**Capability narrowing** (server run without `resources.subscribe`):

```json
{"jsonrpc":"2.0","method":"notifications/subscriptions/acknowledged","params":{"notifications":{"toolsListChanged":true,"resourcesListChanged":true},"_meta":{"io.modelcontextprotocol/subscriptionId":2}}}
```

`resourceSubscriptions` stripped; `promptsListChanged` stripped (no prompts
capability); `toolsListChanged` kept (auto-set by `registerTool`).

**DM privacy (cross-process)**: non-member D's listen ack echoed the DM URI
`octo-santa://channels/smoke-a%2Csmoke-b/messages` (no URI validation in the
router), but across multiple DM sends and poller ticks D received **zero**
updated notifications, and D's `resources/read` was denied:
`{"error":{"code":-32603,"message":"DM channel \"smoke-a,smoke-b\" is private to smoke-a and smoke-b"}}`.
An unbound connection's read is likewise denied.

**URI encoding round-trip**: channel `a#b,c@d.e-f` worked end-to-end —
subscription, ping (`octo-santa://channels/a%23b%2Cc%40d.e-f/messages`,
stamped with the *second* concurrent subscription's id 9, proving per-URI
routing across multiple listens), and read.

**list_changed**: first activity on an unseen channel emitted
`notifications/resources/list_changed` routed + stamped onto the
`resourcesListChanged: true` subscription.

**Legacy era**: `initialize` negotiated `2025-11-25` and advertised
`resources:{subscribe:true,listChanged:true}` (the wart noted above);
`resources/subscribe` returned verbatim
`{"jsonrpc":"2.0","id":4,"error":{"code":-32601,"message":"Method not found"}}` —
**there is no working legacy equivalent in SDK v2**. With the era gate the
legacy connection received no spec notifications; with the gate
force-disabled (prototype env flag) the passthrough was observed verbatim —
unsolicited and unstamped:
`{"jsonrpc":"2.0","method":"notifications/resources/updated","params":{"uri":"octo-santa://channels/legacy-chan/messages"}}` —
confirming the gate is required for legacy spec-compliance.

**Modern without listen**: custom push arrived; spec change notifications
were dropped at the entry (zero on the wire).

**Suite status**: `bunx tsc --noEmit` clean; `bun test` 263 pass / 0 fail
(incl. the hexagonal-boundary arch tests) with the prototype applied.

## Recommendation

**Adopt, with changes.** The mechanism is sound, empirically verified
cross-process, costs one optional port method and ~100 adapter lines, adds
zero latency, and leaks nothing. Changes before landing:

1. Declare `resources.subscribe` **only on modern-era instances** (factory
   already receives the era) so legacy `initialize` stops advertising an
   unserved capability. Keep the emission gate regardless (defense in depth).
2. Drop the two prototype env flags (`OCTO_SANTA_NO_SUB_CAP`,
   `OCTO_SANTA_LEGACY_RESOURCE_PUSH`) — test-only scaffolding.
3. Map adapter denials to proper JSON-RPC error codes instead of the generic
   `-32603` (at minimum resource-not-found for unknown channels).
4. Document in the server instructions (2KB budget) that resources/updated is
   an unfiltered activity ping and `resources/read` never consumes unread.
5. Add unit tests: poller channel-activity dedup, `readHistory` purity +
   guards, `channelResourceUri` round-trip, era gating.

## Open questions

1. **Rename churn**: should the old-URI subscription get any terminal signal
   on rename? (The spec has none for "resource gone"; today it just goes
   silent, with `list_changed` as the only hint.) Consider an explicit
   `updated` ping on the old URI at rename time so subscribers re-read, fail
   with not-found, and re-list.
2. **Silent channel creation**: `list_changed` currently fires on first
   *activity*, not creation. Is a channels-table watermark in the poller
   (max channel id + rename detection) worth the extra per-tick query?
3. **DM channels in `resources/list`**: parity with
   `messaging_list_channels` today, but should DM resources be listed only to
   their members once the resources surface becomes the discovery mechanism
   for standard clients?
4. **Ack-echo of never-deliverable URIs**: should the adapter pre-validate
   subscription URIs? The router offers no hook for it today (entry-served
   before the instance sees the request) — likely an SDK-level question.
5. **Non-member reads of public channels**: `readHistory` requires
   membership (tool parity). Should public-channel resources be readable
   without membership, since names/members are already public?
6. **Read-window shape**: fixed newest-50 for now; expose paging (query
   params in the URI template, e.g. `{?before,limit}`) later?
7. **HTTP transport future**: the HTTP listen router (`createListenRouter`)
   uses SSE streams and a server event bus — the port seam chosen here maps
   onto it unchanged, but the bus wiring differs; revisit when an HTTP
   transport lands.

## Appendix: prototype diff summary

The prototype lived in a throwaway worktree (not committed); this records
what was touched so the implementation can be redone cleanly.

**`src/core/ports.ts`** — two additions: pure-history read on the message
port, optional activity signal on the notification port.

```ts
// MessageRepository:
  // Pure history snapshot: most recent `limit` messages in ascending order,
  // all senders included. Never touches cursors.
  readRecent(channelId: number, limit: number): Message[];

// NotificationPort:
  notifyChannelActivity?(channelName: string): Promise<void>;
```

**`src/storage/sqlite/message-repo.ts`** — `readRecent` implementation:
`SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?` then
`rows.reverse()`; transaction-free WAL read, no cursor involvement.

**`src/core/messaging/service.ts`** — new `readHistory(agentId, channelName,
limit = 50)`: `requireRegistered` + `assertDmAccess` + membership check (same
guards as `read()`), then `messages.readRecent(channel.id, limit)`. Never
advances the cursor; includes the reader's own messages.

**`src/notifications/poller/poller.ts`** — inside `tick()`, collect
`activeChannels = new Set<string>()` from **all** fetched messages (before
the mention filter), then after the per-message loop:
`for (const channelName of activeChannels)
port.notifyChannelActivity?.(channelName).catch(...)`. One ping per channel
per tick; HWM logic untouched.

**`src/transports/mcp-stdio/adapter.ts`** — four changes:

1. Import `ResourceTemplate`; capability declaration in
   `buildConnectionServer`:

```ts
capabilities: {
  experimental: { "claude/channel": {} },
  resources: { subscribe: true, listChanged: true },
},
```

2. Resource registration (new exported `channelResourceUri` +
   `registerChannelResources`, called from `buildConnectionServer` with
   `() => boundAgentId`):

```ts
export function channelResourceUri(name: string): string {
  return `octo-santa://channels/${encodeURIComponent(name)}/messages`;
}

server.registerResource(
  "channel-messages",
  new ResourceTemplate("octo-santa://channels/{channel}/messages", {
    list: () => ({
      resources: messaging.listChannels().map((channel) => ({
        uri: channelResourceUri(channel.name),
        name: channel.name,
        description: `Message history of channel "${channel.name}"`,
        mimeType: "application/json",
      })),
    }),
  }),
  { title: "Channel messages", description: "Recent message history of a channel. Pure read — never advances the unread cursor.", mimeType: "application/json" },
  async (uri, variables) => {
    const raw = variables["channel"];
    const channelName = decodeURIComponent(Array.isArray(raw) ? raw[0] ?? "" : raw ?? "");
    const agentId = getBoundAgentId();
    if (agentId === null) throw new Error("Channel resources require a bound agent: call messaging_register first");
    const messages = messaging.readHistory(agentId, channelName, 50);
    return { contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify(messages) }] };
  }
);
```

3. Update hook — in the `commit()` closure of `onAgentId`, added to the
   per-connection `NotificationPort` (alongside the untouched `notify`),
   era-gated with a per-connection first-seen set:

```ts
const seenChannels = new Set<string>();
const emitResourceUpdates = era === "modern";
// ...
notifyChannelActivity: async (channelName) => {
  if (!emitResourceUpdates) return;
  if (!seenChannels.has(channelName)) {
    seenChannels.add(channelName);
    mcpServer.sendResourceListChanged();
  }
  await mcpServer.server.sendResourceUpdated({ uri: channelResourceUri(channelName) });
},
```

4. One-line wiring after `registerMessagingTools`:
   `registerChannelResources(mcpServer, messaging, () => boundAgentId);`

**`src/main.ts`** — no changes needed; the port flows through the existing
`startPoller(port, agentId)` wiring untouched.
