# Notification Dispatch Consolidation — PRD

> Date: 2026-05-16
> Status: Final — ready for implementation plan
> Author: investigation pass, finalized after Phase 3b retraction (2026-05-16)

**Decision: delete `NotificationDispatch` from core; the cross-process poller becomes the sole push delivery mechanism.**

This decision is firm. On 2026-05-16, the user retracted Phase 3b direct mode (multi-agent-per-process MCP transport) as a planned future. Modern coding harnesses (Claude Code, Cursor, etc.) provide subagents at the harness layer, each running as its own process — so building an in-process multi-agent MCP transport would reinvent the wheel. With that future gone, the dispatcher carries no optionality value, and `docs/architecture.md §Honest Accounting → What this means` has been updated to mark it as scheduled for removal.

---

## Problem Statement

`NotificationDispatch` is a port in `src/core/ports.ts`. `MessagingService.send()` and `directMessage()` call `this.dispatch.dispatch({...})` on every successful message insert, after resolving target agents. The adapter that implements this port — `createNotificationDispatcher` in `src/notifications/dispatch/` — looks up each target agent in an in-memory `Map<string, NotificationPort>`.

The N-process deployment model guarantees that map has at most one entry: the single agent bound to this process. `MessagingService.resolveTargets()` excludes the sender from `targetAgents`. Therefore `handlers.get(targetAgentId)` is always `undefined` in production. The dispatcher's `for` loop runs zero iterations every time. Cross-process delivery is handled entirely by `createNotificationPoller` (an adapter-internal module with no named seam in core), which polls SQLite every two seconds using an adapter-owned HWM.

Two costs result:

1. **A dead module sits at a load-bearing place in core's port surface.** Any developer changing send semantics in `MessagingService` must reason about two delivery paths (dispatch + poll) and write tests against both, even though only one fires in production. The `NotificationDispatch` interface is imported by core, threaded through the constructor, and called inside the transactional send path — it is not a quiet bystander.

2. **Two notification paths in the test surface.** `tests/hex/notifications/dispatch.test.ts`, `tests/hex/core/messaging-dispatch.test.ts`, and `tests/hex/notifications/cross-process-poller.test.ts` each carry a parallel theory of delivery — target resolution, mention filtering, DM handling, sender exclusion — duplicated across the two mechanisms. Drift between them is possible (e.g. pool base-name expansion currently exists in both `resolveTargets()` for the dispatcher and the poller's `shouldNotifyMessage()`).

The architecture doc's `§Honest Accounting` previously named the dispatcher as dead code retained for Phase 3b direct mode optionality. With Phase 3b retracted, that optionality value is zero, and the two costs above are unmitigated.

## Solution

Delete `NotificationDispatch` from `core/ports.ts`, delete the dispatch adapter, remove the dispatch call from `MessagingService.send()` and `directMessage()`, and drop the `register`/`unregister` notification-handler wiring in the MCP transport. The cross-process poller remains as the sole delivery mechanism. The shared SQLite database is the only notification bus.

The 2026-04-09 event-driven dispatch spec remains in `docs/specs/` as historical record. If a future deployment model ever introduces multi-agent-per-process hosting (currently not on any roadmap), an adapter author can re-derive the seam from that record — the cost of re-introducing the port interface is roughly one PR: ~10 lines for the port, ~30 for the adapter, ~5 for service wire-up, plus targeted tests against the new transport.

### Branch (b) — rejected at WIP, rejected again here

Unifying dispatch and poll behind one delivery seam in core was considered. Rejected: a unified "deliver to these targets" port in core would re-introduce an adapter-shaped abstraction (the seam has to know about topology to route in-process vs cross-process) and would conflict with principle 3 in `architecture.md` ("Ports must not be shaped by adapter capabilities"). It also makes the module deeper without making the system simpler — the poller's interface (pull-when-you-can) and the dispatcher's interface (push-now-or-skip) differ fundamentally. Forcing them through one contract trades two clean shallow adapters for one muddy port. With Phase 3b retracted, there is no second adapter to unify with anyway.

## User Stories

1. As a developer changing send semantics (adding a new mention type, changing target resolution), I want exactly one delivery path to reason about, so that I don't have to mentally simulate both an in-process dispatch and a cross-process poll and confirm they agree.

2. As a developer reading `src/core/ports.ts` for the first time, I want every port to describe something core actually needs from an adapter, so that I can trust the port surface as a map of the system's seams.

3. As a future adapter author hypothetically re-introducing in-process dispatch, I want a clearly recorded prior-art spec (the 2026-04-09 event-driven dispatch design) describing what the seam looked like when it existed, so that I can re-add it as part of that adapter's PR without re-deriving the contract.

4. As a test author for `MessagingService.send`, I want one delivery contract under test, so that I'm not writing twin assertions against a dead path.

5. As an ops engineer reasoning about notification latency, I want a single answer — "two-second poll, cross-process, HWM-advanced" — instead of "in the same-process case zero latency via dispatcher, otherwise two-second poll." Today the second clause is vacuous; pretending it isn't muddies the mental model.

6. As a reviewer of any future change to push reliability, I want the only reliability lever — the poller's interval and HWM — to be the only thing I audit, so that I'm not reading the dispatcher to confirm it's still dead.

## Implementation Decisions

The following call sites and modules are affected. Every one of them is named explicitly so the implementation plan can attack them in order.

### Deletions

- **Delete `src/notifications/dispatch/` entirely** (the directory containing `dispatcher.ts`). Nothing else imports from it after the changes below.

- **Delete `NotificationDispatch` from `src/core/ports.ts`** (lines 109–118, the trailing interface in the file). The remaining notification surface in core is just `NotificationPort` (which the poller adapter still needs).

- **Delete the `dispatch` parameter from `MessagingService`'s constructor** (`src/core/messaging/service.ts` line 31) and the corresponding private field. The constructor signature collapses to `(agents, channels, messages, cursors, pid, profiles?)`.

- **Delete the `if (this.dispatch) { ... }` blocks from `send()` and `directMessage()`** in `src/core/messaging/service.ts` (lines 216–233 and lines 303–312 respectively). After deletion, `send()` ends with `return message;` immediately after the `insertAndJoinSender` call, and `directMessage()` does the same.

- **Delete `MessagingService.resolveTargets()` and the helper `isDmChannelWithMembers()`** (`src/core/messaging/service.ts` lines 45–108). Verify before deletion that no other consumer exists — search the codebase for `resolveTargets` and `isDmChannelWithMembers`; the WIP investigation found no callers outside the two dispatch sites that are also being deleted.

- **Delete the `createNotificationDispatcher` import and instantiation from `src/main.ts`** (line 13 and lines 39–40), and drop `dispatcher` from the `MessagingService` constructor call (line 55).

- **Delete `registerNotificationHandler` and `unregisterNotificationHandler` from `McpStdioOpts`** in `src/transports/mcp-stdio/adapter.ts` (the interface fields, the destructure inside `startMcpStdio`, the `registerNotificationHandler(effectiveId, port)` call inside `commit`, and the `unregisterNotificationHandler(boundAgentId)` call in `onclose`). The poller continues to own the `NotificationPort` it's given — nothing else needs to hold a reference to it.

- **Delete the corresponding `dispatcher.register.bind(...)` / `dispatcher.unregister.bind(...)` arguments passed from `main.ts`** to `startMcpStdio` (lines 82–83). The `dispatcher` variable in `main.ts` is gone entirely after this.

### Simplifications

- **`MessagingService.send()` becomes:** validate sender, resolve channel, call `extractMentions` (still needed — mentions are persisted in the `mentions` column for the poller to filter on), call `insertAndJoinSender`, return the message. No notification side effect.

- **`MessagingService.directMessage()` becomes:** validate target, create channel, add both members, extract mentions, insert message, return. No notification side effect. The cross-process poller picks up DM messages because `shouldNotifyMessage` short-circuits on `isDmChannel(channelName)`.

- **Composition root (`src/main.ts`)** shrinks by the `createNotificationDispatcher` import, the `dispatcher` local, and the two bound arguments passed to `startMcpStdio`. The remaining notification wiring is the `startPoller` factory plus the `NotificationPort` constructed inside the MCP adapter's `commit()`.

### Cross-process delivery contract (unchanged)

Cross-process delivery is achieved because every process's poller scans the shared SQLite for messages above its HWM. `shouldNotifyMessage` in the poller handles every case `resolveTargets` previously handled:

- **DM channels:** `isDmChannel(channelName)` short-circuits to `true`. Equivalent to `resolveTargets`' DM branch.
- **`@all` (`"*"`):** `mentions.includes("*")` — equivalent to `resolveTargets`' wildcard branch.
- **Direct agent mentions:** `mentions.includes(agentId)`.
- **Pool base-name mentions:** `baseName != null && mentions.includes(baseName)` — `extractMentions` already writes the base name into the `mentions` column, and the poller is given the bound agent's `baseName` at start time.
- **Sender exclusion:** the poller's `getNewMessagesForAgent` query excludes the sender at the storage layer (this should be re-verified in `SqliteNotificationQueryRepo.getNewMessagesForAgent` as part of the implementation plan — if it doesn't, add the filter there). In any case, the poller's agentId equals the bound agent, and there is no path by which an agent receives its own message.
- **Membership filter:** `resolveTargets` filters targets to `memberIds`. The poller's storage query (`getNewMessagesForAgent`) joins to the channel membership table; non-members do not see the message. Re-verify in the storage repo as part of the plan.

The implementation plan must include a side-by-side audit of `resolveTargets` vs `shouldNotifyMessage` + `getNewMessagesForAgent` to confirm parity before deleting `resolveTargets`. The WIP investigation found no gaps.

### Resulting core port surface

After this change, `src/core/ports.ts` contains: `AgentRepository`, `ProfileRepository`, `ChannelRepository`, `MessageRepository`, `CursorRepository`, `DomainRepository`, `BrainStore`, `NotificationPort`. The "core dispatches push statelessly" sentence in `architecture.md` simplifies to "core writes; the poller adapter delivers." `NotificationPort` itself is a candidate for relocation to `src/notifications/ports.ts` (it's used only by the poller adapter), but that move is mechanical and out of scope for this PRD.

## Testing Decisions

- **Deleted:** `tests/hex/notifications/dispatch.test.ts` (the entire file — tests an adapter that no longer exists).

- **Deleted:** `tests/hex/core/messaging-dispatch.test.ts` (the entire file — every test asserts on the `dispatched` array captured from a wrapped dispatcher, which no longer exists). The cross-process equivalents in `tests/hex/notifications/cross-process-poller.test.ts` already cover the same delivery cases end-to-end through SQLite.

- **Rewritten:** `tests/hex/core/messaging-service.test.ts` — drops the dispatcher argument from `MessagingService` construction in setup helpers. Behavior under test is unchanged.

- **Rewritten:** `tests/hex/notifications/cross-process-poller.test.ts` — drops the dispatcher import and any dispatcher instantiation that exists only to satisfy the (now-removed) constructor parameter. No assertions change.

- **Kept unchanged:** `tests/hex/notifications/poller.test.ts` (poller in isolation), `tests/hex/storage/notification-query-repo.test.ts`, `tests/architecture/hexagonal-boundaries.test.ts`.

- **Canonical contract test post-deletion:** the cross-process poller integration tests already exercise the full path — `MessagingService.send` writes to SQLite, a separate poller instance reads from SQLite and invokes the `NotificationPort` exactly once per qualifying message with the right meta. They remain the canonical contract test. No new tests are required.

## Out of Scope

- MCP 2.0 server-initiated push and session resumability.
- `messaging_listen` long-poll tool.
- Mention semantics changes (`@here`, group mentions beyond base-name pools).
- Slot allocation and profile pool sizing.
- Replacing or restructuring the poller's HWM strategy.
- Moving `NotificationPort` out of core (separate follow-up — currently used only by the poller adapter, but the move is mechanical and not interesting in this PRD).
- Any change to the read-path (`messaging_read_messages`, cursors).

## Further Notes

The `§Honest Accounting` section of `docs/architecture.md` was the contested point throughout the WIP. As of 2026-05-16 it has been updated to align with this PRD:

- `§Notification Delivery` now states the in-process dispatcher is "currently dead code and scheduled for removal" and points at this PRD by filename.
- `§Honest Accounting → What this means` records the Phase 3b retraction explicitly: "modern coding harnesses (Claude Code, Cursor, etc.) provide subagents at the harness layer, with each subagent running as its own process. Building an in-process multi-agent MCP transport would reinvent the wheel."
- `§Adding New Adapters` now directs new transport and notification adapters to wire the cross-process poller, noting the in-process dispatcher is being removed.

The architecture doc and this PRD are consistent: there is one delivery mechanism in production (the poller), one delivery mechanism after this change (the poller), and no port in core whose only purpose is optionality for a retracted roadmap item.

The original Phase 0-pre vision — "eliminate polling" — is permanently unrealizable under the N-process deployment model. SQLite-as-only-shared-state requires polling (or a future OS-level file-watcher / IPC bridge / MCP 2.0 push). The Phase 0-pre dispatcher was an attempt to honour the vision that turned out to be incompatible with how octo-santa actually runs. Removing it is recognising that fact in code, not a regression.

The 2026-04-09 event-driven dispatch design spec remains committed as historical record. It is a complete description of what the dispatcher looked like and why; any future in-process delivery mechanism can start from it.
