# Session Binding — PRD

> Date: 2026-05-16
> Status: Proposed
> Scope: `src/transports/mcp-stdio/`

---

## Problem Statement

In `src/transports/mcp-stdio/adapter.ts`, the `startMcpStdio()` body holds four closure variables — `boundAgentId`, `pollerRef`, `heartbeatTimer`, `boundProfile` — and a closure function `onAgentId` that together manage one conceptual thing ("this MCP session is bound to agent X") but operationally six:

1. The bind-once invariant (reject mismatched `agent_id` on subsequent tool calls).
2. Deferred commit-after-tool-success (register must not bind on validation failure or name-taken error; the binding only fires after `messaging.register()` returns the resolved name).
3. `NotificationPort` construction over the MCP server's `notifications/claude/channel` push.
4. Poller lifecycle (start on bind with the resolved name + `baseName` for mention matching; stop on close).
5. Heartbeat lifecycle (start a 10s interval on bind; stop it on `"lost"` reclaim or on close).
6. `onclose` teardown (clear timer, stop poller, fire `onDisconnect`).

The state machine for these concerns is real, but it has no name and no seam. It is smeared across `startMcpStdio` and `onAgentId`, with `boundProfile` mutation happening through a *separate* `onProfile` callback that must complete between `messaging.register()` and the deferred `commit()` call. The ordering is correct today, but it's an invariant enforced by inspection, not structure.

The deletion test confirms this is a deep module that earns its keep: if the closure is removed, every tool that calls `register`, `send`, `directMessage`, `subscribe`, `createChannel`, `read`, `renameChannel`, `getInstructions`, or `claimDomain` would have to re-implement the bind check and lifecycle wiring. But "earns its keep" is not the same as "has a name." The current shape makes the transport file the home of a state machine that does not belong to MCP tool registration — it belongs to the session.

## Solution

Extract a `SessionBinder` module local to `src/transports/mcp-stdio/`. The binder owns the entire session-binding state machine and the three collaborators that hang off it. `startMcpStdio()` becomes a wiring file: it builds the binder, hands it to the tool registration functions (replacing the current `onAgentId` / `onProfile` callbacks), and installs `binder.close()` as the `onclose` handler.

The binder exposes a small surface:

- `intent(agentId)` — returns a *bind intent* handle. The intent enforces the bind-once invariant immediately (throws on mismatch) but defers the actual bind side-effects until the caller invokes `intent.commit(resolvedName?)`. This preserves the current contract that failed operations (invalid name, taken name, registration errors) do not bind the session.
- `attachProfile(profile)` — records the profile snapshot so the binder can pass `baseName` to the poller factory at commit time. Called by the `messaging_register` tool between `messaging.register()` and `commit()`.
- `close()` — runs the teardown sequence idempotently (safe to call when the binder is still Unbound).

State machine:

```
  Unbound ──intent(A).commit(R?)──► Bound(effectiveId = R ?? A)
     │                                  │
     │                                  ├──intent(X≠effectiveId)──► throws (stays Bound)
     │                                  │
     │                                  ├──heartbeat returns "lost"──► HeartbeatLost
     │                                  │     (timer cleared; binding intact)
     │                                  │
     │                                  └──close()──► Closed (teardown + onDisconnect)
     │
     ├──intent(A).commit() — A bound; commit again is a no-op (idempotent)
     │
     └──close()──► Closed (no-op teardown)
```

The three collaborators (`mcpServer`, poller factory, heartbeat repo + interval) are constructor-injected. The binder doesn't import them; it receives them. Core stays untouched. The poller module stays untouched. The in-process dispatcher is being removed in a concurrent PRD (see Further Notes); the binder never depended on it conceptually — it just happened to hold the register/unregister wiring inline.

## User Stories

1. **As a developer adding a new MCP tool**, I want a single primitive (`binder.intent(agentId)`) that encodes the bind-once check and commit-on-success contract, so that I never reproduce the register-vs-other-tool divergence and never accidentally bind on a failed tool call.

2. **As a developer reading `adapter.ts` cold**, I want the session lifecycle to live in a named module with a documented state machine, so that I don't have to reconstruct the meaning of four closure variables and two callback shapes from their use sites.

3. **As a future adapter author building an HTTP/SSE transport**, I want the *pattern* of deferred-commit session binding to be visible and copyable (even if the concrete `NotificationPort` differs), so that I can build a structurally analogous binder without re-discovering the invariants from the MCP code.

4. **As a test author covering bind / unbind / disconnect**, I want to drive the binder directly with fake collaborators and assert on what it called when, so that I can unit-test the state machine in isolation instead of spinning up a full MCP server with mocked tool handlers.

5. **As a test author covering profile-based name resolution**, I want `attachProfile` and `commit(resolvedName)` to be observable in tests without monkey-patching closure variables, so that the existing `tests/messaging/binding.test.ts` scenarios become assertions on the binder's exposed lifecycle rather than on internal state.

6. **As an ops engineer reasoning about heartbeat behavior**, I want the heartbeat timer's "lost" path (reclaim by another process) to be a named transition in one module, so that I can correlate logs to a specific state without grepping `startMcpStdio`.

7. **As a maintainer fixing a late-`onclose` race**, I want `close()` to be safe to call from Unbound, Bound, and post-`HeartbeatLost` states, so that I don't need to inspect every guard in the current `onclose` block to convince myself it's correct.

8. **As a developer touching the `NotificationPort` construction**, I want the port that wraps `mcpServer.server.notification(...)` to be built inside the binder (the only thing that owns its lifetime), so that the port can't outlive the binding or be observed by code that doesn't own it.

## Implementation Decisions

### New module: `SessionBinder` (transport-local)

Lives under `src/transports/mcp-stdio/`. Not under a new `src/transports/session/` home. Justification:

- The port it constructs wraps the MCP-specific `mcpServer.server.notification({ method: "notifications/claude/channel", ... })` call. The push transport is part of the MCP capability negotiation.
- A future HTTP/SSE adapter will need a structurally analogous binder, but the concrete wiring (which notification primitive, whether bind is deferred, what "commit" means when there's no register-vs-other-tool distinction) will differ. Following the architecture's "interfaces over implementations" rule, we don't generalize before the second concrete case exists.
- Cross-adapter imports are forbidden by `CLAUDE.md`. A shared `src/transports/session/` would either become a cross-adapter import target (forbidden) or duplicate the rule by being conceptually shared without being a port (worse — invisible coupling).
- Pattern reuse is documented in this PRD and in the binder's module-level comment. When the HTTP transport ships, the right time to extract a port is then, informed by two cases.

### Binder shape (prose, not code)

The binder is created by a factory that takes:

- The MCP server instance (used to build the `NotificationPort` and as the `onclose` host).
- The poller factory (`startPoller` — unchanged).
- The `AgentRepository` (for heartbeat) and a heartbeat interval ms.
- The `onDisconnect` callback.

It exposes three methods to the tool layer (`intent`, `attachProfile`, `close`) and nothing else. Its internal state is the current binding state (Unbound | Bound(effectiveId)), the captured profile snapshot, the timer reference, the poller reference, and the constructed notification port.

### Replacing the current callbacks

`registerMessagingTools` and `registerBrainTools` currently take two adapter-shaped callbacks: `onAgentId` (returns a `{ commit }` handle) and `onProfile`. These become a single dependency: the binder. The tools call `binder.intent(agent_id)` instead of `onAgentId(agent_id)`, and the register tool calls `binder.attachProfile(profile)` instead of the `onProfile` callback.

The `withAgent` helper continues to exist but is rewritten to take the binder instead of the callback. It performs the same eager-commit pattern (`intent → run → commit`) for all tools other than `messaging_register`. The deferred-commit pattern in `messaging_register` is unchanged in spirit: `intent(agent_id)` first, then `messaging.register()`, then `binder.attachProfile(...)` if a profile resolved, then `intent.commit(resolvedName)`.

### Lifecycle transitions — what triggers commit and release

- **Commit** fires on the first successful tool call that takes an `agent_id`. Concretely: after `messaging.register()` returns, or after any other agent-scoped tool's underlying service call returns. The current behavior — that a failed `register` (invalid name, taken name) does not bind — is preserved by virtue of `commit()` running only after the service call returns normally.

- **Release** fires from `close()` only. The MCP server's `onclose` invokes `binder.close()`. The binder runs teardown in order: clear heartbeat timer, stop poller, then call `onDisconnect(effectiveId, process.pid)` (only if Bound). All steps are individually idempotent so partial-construction failure modes (e.g., bind committed but poller factory threw) are still safely closable.

- **Heartbeat "lost"** is an internal state transition. The timer callback inspects the repo's return and clears its own interval on `"lost"`. The binding remains in place (so a subsequent late `close()` still calls `onDisconnect`); only the timer side-effect is cancelled. This matches current behavior.

### How the poller hooks in

The binder is the *only* code that invokes the poller factory. The poller module is unchanged. This preserves the architectural rule "adapters don't talk to each other" by funneling the notification-adapter touchpoint through the transport binder, which holds the poller factory as an injected collaborator.

### How `boundProfile` is captured

`attachProfile` is called by the `messaging_register` tool synchronously between `messaging.register()` returning and `intent.commit()` being invoked. The binder stores the profile snapshot on its internal state. At commit time, `baseName` is read from the snapshot and passed to the poller factory as the third argument (unchanged signature). If `attachProfile` is never called (agent name doesn't match a profile), the binder passes `undefined` — same as today.

The temporal coupling that exists today (`onProfile` must be called before `commit`) becomes explicit and local: it's a documented contract between the register tool body and the binder, and it's testable by calling `attachProfile` and `intent.commit` in either order against a fake binder and asserting that the resulting poller factory call sees the expected `baseName`.

### `onclose` becomes one line

`mcpServer.server.onclose = () => binder.close();`. All teardown logic moves into `binder.close()`.

## Testing Decisions

### New module-level tests for `SessionBinder`

Unit-testable against fakes for the three collaborators. Good tests exercise external behavior — given a sequence of `intent` / `commit` / `attachProfile` / `close` calls, assert the right collaborator calls happen in the right order with the right arguments. No assertions on internal state fields.

Scenarios that become unit-testable on the binder (previously only testable through the full MCP server or omitted entirely):

- `intent(A)` then `intent(A).commit()` starts the poller exactly once and starts the heartbeat exactly once — both with `effectiveId = "A"`.
- `intent(A).commit("A-1")` (profile resolution) starts the poller under `"A-1"`, not `"A"`.
- `attachProfile({ baseName: "os-dev", ... })` before commit causes the poller factory to be called with `baseName === "os-dev"`.
- `intent(A)` followed by `intent(B)` (no commit between) throws on the second call; no poller starts, no timer starts.
- `intent(A).commit()` then `intent(B)` throws; the binding to `A` is intact.
- `intent(A).commit()` called twice is a no-op on the second call (no double poller, no double timer).
- Heartbeat callback returning `"lost"` clears the timer; subsequent `close()` still stops the poller and calls `onDisconnect`.
- `close()` on an Unbound binder is a no-op — does not call `onDisconnect`, does not touch the poller.
- `close()` on a Bound binder calls teardown in order and is idempotent on a second invocation.

### Tests that already exist and must keep passing

- `tests/messaging/binding.test.ts` — drives `registerMessagingTools` with a hand-rolled `onAgentId` callback that emulates the current binder contract. After the refactor, the test's setup function swaps the callback for a real or fake `SessionBinder`. The behavioral assertions (mismatched-agent rejection, failed-register not binding, profile name resolution) are unchanged.
- `tests/messaging/lifecycle.test.ts` — exercises the `MessagingService` directly (`unregister`, late-`onclose` races, crash recovery). These tests don't touch the binder and need no changes. They remain the definitive coverage for *what `onDisconnect` ends up doing* through the service.
- `tests/hex/notifications/cross-process-poller.test.ts` — unchanged. The binder calls the poller; the poller's own contract is independently tested. (`tests/hex/notifications/dispatch.test.ts` is being removed alongside the dispatcher in the consolidation PRD — not this PRD's concern.)

### What still needs MCP-server-level integration testing

- The end-to-end sequence: real `McpServer` → `onclose` fires → `binder.close()` → `messaging.unregister()` is called. This is one small wiring test. It guards the `mcpServer.server.onclose = binder.close` line and nothing else.
- The bootstrap notification fires (existing behavior, not binder behavior, but lives in `startMcpStdio` — unchanged by this refactor).

## Out of Scope

- Building an HTTP/SSE transport. This refactor positions us to do that without paying double, but the binder stays MCP-local until the second transport materializes.
- Redesigning the poller. It is correct and stable; the binder is purely an organizational refactor of code that currently lives in `adapter.ts`.
- Changing the profile or registration data flow. `MessagingService.register()` is untouched. The `RegisterResult` shape is unchanged.
- Eliminating the dispatcher. That work is tracked separately in `docs/specs/2026-05-16-notification-dispatch-consolidation-prd.wip.md`; this PRD merely stops the binder from touching it.
- Adding a port for session binding in `src/core/ports.ts`. Session binding is purely a transport concern; core does not need to know it exists. The architecture's principle 3 ("ports must not be shaped by adapter needs") forbids creating one here.

## Further Notes

- **Prerequisite / concurrent change:** the dispatch consolidation PRD (`docs/specs/2026-05-16-notification-dispatch-consolidation-prd.wip.md`) removes `NotificationDispatch` from core and deletes `src/notifications/dispatch/`. This PRD assumes the binder no longer owns dispatcher handler register/unregister wiring. If the consolidation lands first, the binder is built clean; if this lands first, the binder simply doesn't reintroduce the wiring and the `McpStdioOpts.registerNotificationHandler` / `unregisterNotificationHandler` fields are removed alongside it.
- Implementation should keep the `withAgent` helper in `src/transports/mcp-stdio/helpers.ts` as the per-tool eager-commit wrapper, retargeted to the binder. The deferred-commit usage stays inline in the `messaging_register` tool body — `register` is the *only* tool that needs to interleave a service call between `intent` and `commit`, and inlining keeps that distinction visible.
- Relevant prior specs:
- `docs/specs/2026-04-04-hexagonal-architecture-design.md` — port boundaries that this refactor must respect.
- `docs/specs/2026-04-10-cross-process-notification-poller.md` — poller contract; binder owns its lifecycle.
- `docs/specs/2026-04-12-persistent-agent-profiles-design.md` — profile snapshot data flow; binder captures via `attachProfile`.
- `docs/specs/2026-05-16-notification-dispatch-consolidation-prd.wip.md` — concurrent change removing the in-process dispatcher; this PRD assumes that wiring is gone (see Further Notes).
- Follow-up worth tracking after the second transport lands: revisit whether a `SessionBinder` port (or shared abstract base) should live in a transport-local-but-shared location. Do not pre-empt that decision now.
- The current `boundProfile` carries `persona`, `objective`, and `instructions` fields that the binder does not use (only `baseName` flows to the poller). The other fields are kept on the snapshot for symmetry with the existing `onProfile` callback shape and in case future binder behavior needs them; they cost nothing.
