---
title: Mention Resolver — Unified core module for "who does this message hit?"
summary: Originally proposed unifying extractMentions, resolveTargets, and shouldNotifyMessage into one core module. Re-scoped to "do not pursue" after the in-process dispatcher was scheduled for removal — resolveTargets becomes deletable, collapsing the unification's leverage.
tags: [mentions, messaging, notifications, refactor, hexagonal, deep-module, deferred]
---

# Mention Resolver

> Date: 2026-05-16
> Status: WIP — Recommendation: **DO NOT PURSUE** (superseded by dispatch consolidation)
> Clarity: 95/100, Confidence: 92/100

## Recommendation

**Drop this refactor.** The premise no longer holds after the in-process notification
dispatcher was scheduled for removal (see
`docs/specs/2026-05-16-notification-dispatch-consolidation-prd.wip.md` and
`docs/architecture.md §Honest Accounting → What this means`).

The original PRD argued for collapsing three call sites of mention semantics. Two of
the three sites — `extractMentions` (send-time canonicalization) and
`shouldNotifyMessage` (poller predicate) — remain. The third —
`MessagingService.resolveTargets` — has exactly one consumer:
`NotificationDispatch.dispatch()`. When the dispatcher is deleted, `resolveTargets`
is dead code and goes with it. That single fact removes the load-bearing argument
of this PRD ("send-side and receive-side must agree by construction") because
there is no longer a non-trivial send-side target-resolution path to disagree with.

The remaining drift surface — `extractMentions` produces a JSON array, the poller
consumes it with one `includes()` check and a DM short-circuit — is small,
already covered by tests in `tests/messaging/mentions.test.ts` and
`tests/hex/notifications/poller.test.ts`, and not worth a new `core/mentions/`
module.

## What changed since this PRD was written

Earlier on 2026-05-16, the user retracted Phase 3b multi-agent-per-process direct
mode as a planned future. Modern coding harnesses (Claude Code, Cursor) provide
subagents at the harness layer, with each subagent running as its own process —
so building an in-process multi-agent MCP transport would reinvent the wheel.

Consequence: the in-process `NotificationDispatch` port and its dispatcher
adapter (`src/notifications/dispatch/dispatcher.ts`) are now dead code and
scheduled for removal. The architecture doc was updated to reflect this. See
the dispatch consolidation PRD for the deletion plan.

## Re-assessed call-site inventory

Confirmed by reading `src/core/messaging/service.ts`, `src/core/utils.ts`,
`src/notifications/poller/poller.ts`:

1. **`extractMentions(content, validIds, profileBaseNames?)`** — `core/utils.ts`.
   Called by `MessagingService.send()` and `MessagingService.directMessage()`
   to produce the JSON array persisted on the `messages.mentions` column.
   **Retained after dispatcher removal.** It is the sole producer of the
   storage shape.

2. **`MessagingService.resolveTargets(channelId, channelName, mentions, senderId)`**
   — private method. Called from one place: `send()` inside `if (this.dispatch)`,
   feeding `this.dispatch.dispatch({ targetAgents, ... })`. The result never
   escapes the service — `send()` returns the `Message`, not the targets.
   `directMessage()` does not even call `resolveTargets`; it inlines
   `targetAgents: [targetAgentId]` directly into the dispatch call.
   **Deletable when the dispatcher is removed.** No other consumer.

3. **`shouldNotifyMessage(channelName, mentionsJson)`** — closure inside
   `createNotificationPoller`. Reads the stored `mentions` array, applies a DM
   short-circuit (`isDmChannel`), and checks `mentions.includes(agentId) ||
   mentions.includes(baseName) || mentions.includes("*")`. **Retained.** It is
   the only consumer of mention semantics on the receive side, and the
   cross-process poller is the sole push mechanism after dispatcher removal.

The "three call sites" framing was structurally correct on 2026-05-16 morning.
By 2026-05-16 afternoon, it became "two call sites plus dead code".

## Why the remaining two-site unification is not worth pursuing

With `resolveTargets` gone, the remaining unification candidates are:

- `extractMentions` — token parsing and canonicalization. ~25 lines, pure.
- `shouldNotifyMessage` — a 6-line `includes()` check plus DM short-circuit.

The asymmetries that motivated the original PRD mostly lived in
`resolveTargets`:

- **DM detection divergence** (`isDmChannelWithMembers` vs `isDmChannel`):
  resolved trivially by deleting the send-side variant along with `resolveTargets`.
  Both sides converge on `isDmChannel` from `core/utils.ts`.
- **Base-name expansion semantics living in the service**: resolved by
  deletion. The send-side no longer expands base names at dispatch time
  because there is no dispatch. The poller's literal base-name match against
  the stored `mentions` column becomes the only base-name predicate in the
  system. There is nothing left to drift against.
- **`@*` broadcast asymmetry**: resolved by deletion. The send-side no longer
  expands `"*"` to channel members; the poller's `mentions.includes("*")` is
  the only `@*` predicate.

What remains is the trivial coupling that `extractMentions` writes the JSON
array and the poller reads it. This is the kind of contract that lives
naturally at the storage-column boundary, is exercised end-to-end by
`tests/hex/notifications/cross-process-poller.test.ts`, and does not benefit
from a new module wrapper.

## Cost vs benefit

**Cost of pursuing the refactor anyway:**
- New `core/mentions/` directory with 4 exported operations.
- Migration of `extractMentions` call sites in `send()` and `directMessage()`.
- Rewrite of `shouldNotifyMessage` as a call to `isHit`.
- New test files (`tests/hex/core/mentions.test.ts`,
  `tests/hex/core/mentions-invariant.test.ts`), with the invariant test now
  mostly trivial because `resolveTargets` no longer exists to be the other
  half of the invariant.
- Code review and rollout overhead.

**Benefit:**
- One module path for "where is mention logic?" instead of two
  (`core/utils.ts::extractMentions` and `poller.ts::shouldNotifyMessage`).
- Slightly cheaper future mention-shape additions (`@role:`, `@team-`).

The benefit is real but small. The cost is non-trivial. The leverage that
justified the PRD on 2026-05-16 morning — forcing send-side and receive-side
predicates to agree by construction — is gone.

## What to do instead

1. **Remove the in-process dispatcher** per
   `docs/specs/2026-05-16-notification-dispatch-consolidation-prd.wip.md`. That
   PR will naturally delete `resolveTargets`, `isDmChannelWithMembers`, the
   `NotificationDispatch` port, and the `if (this.dispatch)` blocks in
   `send()` / `directMessage()`.
2. **Leave `extractMentions` where it is** in `core/utils.ts`. It is a pure
   domain utility next to other pure domain utilities. Moving it for its own
   sake is busywork.
3. **Leave `shouldNotifyMessage` inside the poller**. It is the poller's
   predicate; isolating it gains nothing once it is the only consumer of
   stored mentions.
4. **Revisit only if a new transport adapter needs the predicate.** A future
   MCP 2.0 push adapter or HTTP/SSE notifier that needs to compute "would
   viewer V be notified by this stored message?" would justify extracting a
   shared `isHit(mentions, channelName, viewer)` helper. Until that need
   materializes, the duplication-cost is one 6-line function in one file.

## Open Questions

The recommendation to drop is firm given current scope. These are residual
questions a future revisit would need to answer if the decision were
reopened:

1. **Does the dispatch consolidation PRD actually land?** This PRD's "drop"
   recommendation is conditional on the dispatcher being removed. If the
   dispatcher stays for any reason (e.g. an in-process multi-agent transport
   reappears on the roadmap), `resolveTargets` survives and the original
   three-site framing returns. Re-open this PRD in that case.

2. **Will `messaging_listen` (Phase 1 long-poll) need its own predicate?**
   `docs/specs/2026-04-10-cross-process-notification-poller.md` describes a
   future long-poll tool. If it implements its own filter logic instead of
   reusing the poller's, drift risk returns and the case for extracting
   `isHit` strengthens. Today's plan is for `messaging_listen` to reuse the
   same poller-style predicate.

3. **Does a future MCP 2.0 push adapter need a shared predicate?** Same
   question, different transport. Today: no concrete adapter exists. If/when
   one is designed, extract `isHit` then.

4. **Is `isDmChannelWithMembers` worth keeping as a defensive check?** The
   original PRD argued for dropping it in favour of pattern-only `isDmChannel`.
   The dispatch consolidation PRD inherits this question. Resolution:
   probably drop with the rest of `resolveTargets`, since channels named in
   DM form are only ever created via `directMessage()` which establishes the
   member invariant. Defer to the dispatch consolidation PR.

## Original PRD content (preserved for reference)

The body below is the original problem framing as it stood before the
re-assessment. It is preserved so that anyone who reopens this PRD has the
full case the author originally made. **Do not act on this section** without
also reading the re-assessment above.

### Problem Statement (original)

The question "what is a mention, and does this message hit agent X?" is currently
answered by three modules that each see a slightly different slice of the world.

- `core/utils.ts :: extractMentions(content, validAgentIds, profileBaseNames?)`
  parses `@name` tokens from message content and produces the JSON array
  persisted on the `messages.mentions` column. It knows about reserved broadcast
  tokens (`@all`, `@here` → `"*"`), valid agent IDs, and profile base names.
  It does not know about channels, DMs, membership, or liveness.

- `core/messaging/service.ts :: resolveTargets(channelId, channelName, mentions, senderId)`
  is the send-side authority. It runs inside `send()` and `directMessage()`,
  consumes the stored mentions list plus the full world (channel members from
  `ChannelRepository`, profile base names from `ProfileRepository`, live
  instances of a base name from `AgentRepository.findByBaseName`, liveness via
  `isAgentActive`), and returns the concrete `targetAgents[]` handed to
  `NotificationDispatch`. It encodes DM auto-targeting, `@*` broadcast over
  channel members, base-name expansion to live pool instances, sender exclusion,
  and the channel-membership filter.

- `notifications/poller/poller.ts :: shouldNotifyMessage(channelName, mentionsJson)`
  is the receive-side authority for cross-process delivery. Given a row read
  from shared SQLite by an agent who did not send it, it decides whether the
  poller's bound agent should be notified. It re-applies a DM check
  (`isDmChannel(channelName)`), JSON-parses `mentions`, and asks whether the
  bound `agentId`, optional `baseName`, or `"*"` is in the list.

There is no single owner of "what is a mention?" The three sites share token
shapes through the `mentions` column but encode the predicate three different
ways. The original PRD enumerated three concrete asymmetries (DM detection
divergence, base-name semantics living in the service, `@*` as broadcast on
send-side and literal token match on receive-side).

### Original solution sketch

A single pure core module — `core/mentions/` — owning the mention predicate
end to end with four operations: `extractTokens`, `canonicalize`,
`resolveTargets`, `isHit`. The four operations were intended to share unit
tests for cross-cutting invariants, and an invariant test was to assert
`isHit` agrees with `resolveTargets` for any plausible channel view where
the viewer is a member.

This solution is now overkill for the remaining scope. See the
recommendation at the top of this file.
