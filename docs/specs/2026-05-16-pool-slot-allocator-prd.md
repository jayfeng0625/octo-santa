# Pool Slot Allocator — Design PRD

> Date: 2026-05-16
> Status: Proposed
> Related: docs/specs/2026-04-12-persistent-agent-profiles-design.md
> Tracks: issue #18 (pool slot allocator race)

## Erratum (2026-05-20)

§"Cost of doing nothing" below originally stated that "today, the policy works ... cross-process concurrency tests pass." That is materially wrong. Verification after the Phase 0b stack merged (issue #18) showed `tests/hex/core/profile-concurrency.test.ts` case (b) — 3 workers racing for 3 slots — fails 4/5 runs, returning 1-2 unique names instead of 3. Cases (a) and (c) in the same file still pass, so the `.exclusive()` + `withRetrySync()` machinery is sound for the simpler scenarios; the bug is specific to multi-slot read-then-write races under contention.

**This elevates the refactor from "deepening move" to "bug-fix vehicle."** The planned `PoolSlotAllocator` pure function with synthetic-input unit tests is the natural place to land the correctness fix while restructuring the boundary. Two implications for the implementation plan:

1. **Cross-process integration tests stay as correctness guards.** The original framing implied that cross-process tests would be retargeted to verify *only* the transaction boundary post-refactor, with policy correctness moving to pure-function unit tests. Given #18, those integration tests must continue to assert end-to-end correctness as well. Both layers matter.
2. **Success criteria gains a regression guard.** Issue #18's specific failure mode (3 workers, 3 slots, <3 unique names) must pass 5/5 runs after the refactor, not as an incidental property but as an explicit acceptance check.

The rest of the PRD stands. The refactor's structural intent — pure-function policy, callback-scoped transactional session, storage adapter shrunk to row CRUD — is exactly the right shape for landing both the boundary cleanup and the correctness fix in one piece of work.

## Problem Statement

Pool slot allocation policy currently lives in `SqliteAgentRepo.registerWithProfile()` (~80 lines, `src/storage/sqlite/agent-repo.ts:87–167`). The rule set — *"if this PID already owns a slot, reuse it; else reclaim the lowest dead slot; else use the next unused slot; else fail at capacity"* — is octo-santa policy, not storage policy. To make that rule set fit, the storage adapter has been forced to import domain knowledge it has no business owning: `isProcessAlive`, `PID_STALE_MS`, the `{baseName}-{n}` numbering convention, and the rules for partitioning existing rows into "live", "dead", and "owned-by-me" buckets.

The `AgentRepository` port leaks the same concerns. `registerWithProfile` takes `baseName`, `maxInstances`, and `profileFields`, then quietly applies the allocation policy on the way to inserting a row. A future Postgres adapter would have to re-implement the same policy, in the same order, against the same liveness predicates — or risk subtly different slot selection between backends. That is the textbook symptom of a port shaped by adapter capability: core's policy is hiding behind a write method.

Apply the deletion test. If `registerWithProfile`'s allocation logic moved up next to `MessagingService.register` (which already handles profile lookup, singleton-vs-pool branching, suffixed-namespace reservation, and auto-join), the storage adapter shrinks to row CRUD and the policy lives next to the rest of the profile-registration story. Profile policy is then concentrated in one module, fronted by one method, exercised by one set of tests — a deepening move.

The cost of doing nothing is real but bounded: today, the policy works, it's guarded by SQLite `.exclusive()` + `withRetrySync()`, and the cross-process concurrency tests pass. The pain shows up the next time the policy changes (e.g. "reclaim oldest dead slot" instead of "lowest", or "skip slot 1 if a profile-specific reservation exists"), or the first time a second storage adapter ships.

## Solution

Introduce a `PoolSlotAllocator` module in `src/core/profiles/`. The allocator is a pure function over a small input record: the list of existing instance rows (just the fields it needs — `id`, `pid`, `last_seen_at`), the caller's `pid`, `maxInstances`, the `baseName`, an injected liveness predicate, and the current time. It returns a `SlotDecision` discriminated union — `ReuseOwned`, `ReclaimDead`, `NewSlot`, or `AtCapacity` (carrying enough context to render the existing user-facing error message verbatim).

`MessagingService.register()` drives the registration transaction. It calls a new `AgentRepository` port method that opens an exclusive transaction and hands core a *transactional session* — an opaque object with two narrow operations: read the existing instances for a base name, and write the chosen agent row. Inside that callback, the service calls the allocator, applies the decision, and returns the result. The service never imports `bun:sqlite` and never sees a `Database` handle; the adapter never sees `isProcessAlive`, `PID_STALE_MS`, or the instance-number convention.

The invariant the existing design protects — *the read of existing slots and the write of the chosen slot must happen under one `.exclusive()` lock, with `withRetrySync()` wrapping the whole thing* — is preserved because the transaction boundary is exactly the callback boundary. Concurrency behavior does not change: identical retries, identical lock scope, identical race resolution as today's `registerWithProfile`. The boundary moves; the guarantees don't.

After the refactor, `SqliteAgentRepo` no longer imports `isProcessAlive` or `PID_STALE_MS`. `registerWithProfile` is deleted from both the `AgentRepository` port and the adapter. The adapter gains one new port method that exposes a transactional read/write window over the agents table, scoped to a single `baseName`. That method is the only new SQLite-side surface area.

## User Stories

1. As a developer working on `MessagingService.register`, I want pool slot policy to live next to the other registration branching (profile lookup, singleton vs. pool, suffixed-namespace reservation, auto-join) so that I can read all of registration's decisions in one place without jumping into a storage adapter.

2. As a developer changing the slot policy (e.g. switching reclaim from "lowest dead slot" to "oldest dead slot" by `last_seen_at`), I want to edit one pure function and update one set of pure unit tests, without touching SQLite code or worrying about transaction boundaries.

3. As an agent operator running a pool profile, I want exactly the same observable behavior I have today — same slot numbering, same reclaim ordering, same at-capacity error message, same cross-process race resolution — so that nothing I depend on changes.

4. As a future adapter author swapping SQLite for Postgres (or for an in-memory fake in tests), I want to implement only row CRUD plus a single "open a profile-registration transaction, give core a read/write handle" method. I should not need to re-implement the allocation rules or re-discover the liveness convention.

5. As a test author writing pool allocation tests, I want to exercise the policy against synthetic inputs (a list of pretend rows, a fake clock, a stubbed liveness predicate) without spinning up SQLite or `Bun.spawn` workers. The cross-process tests in `tests/hex/core/profile-concurrency.test.ts` remain — they're verifying the transaction boundary, not the policy.

6. As a developer reviewing a change, I want to see the boundary test (`tests/architecture/hexagonal-boundaries.test.ts`) catch any future drift where storage imports liveness helpers or core imports `bun:sqlite`. The refactor removes one existing boundary violation in spirit: `SqliteAgentRepo` currently imports `isProcessAlive` and `PID_STALE_MS` from `core/utils.ts`. That import goes away.

7. As a developer reading `core/ports.ts`, I want the `AgentRepository` port to describe storage needs (find, upsert, heartbeat, clear-pid), not domain policies. The bloated `registerWithProfile` signature — with `maxInstances`, `profileFields`, and a structured return type — should disappear.

## Implementation Decisions

**One new core module: the pool slot allocator.** It lives in `src/core/profiles/` alongside the existing `types.ts`. Its public surface is a single pure function that takes a small record — base name, maximum instances, caller PID, the current time, an injected `isAlive(pid, lastSeenAt)` predicate, and a list of `{ id, pid, last_seen_at }` records for existing instances with that base name — and returns a `SlotDecision`. Decisions are a discriminated union: `ReuseOwned` (carrying the existing agent id and instance number), `ReclaimDead` (carrying the registered name the new owner will inherit and the instance number), `NewSlot` (carrying the freshly chosen instance number and the registered name to be created), and `AtCapacity` (carrying the list of active instances for the error message). No exceptions: the allocator returns `AtCapacity`; the caller (the service) translates it into the existing `Error` to preserve the exact error text.

Singleton handling stays inside the allocator: when `maxInstances === 1`, the allocator either returns `ReuseOwned` (caller PID owns it), `AtCapacity` (another live PID owns it — matches today's "already active" path with a `maxInstances: 1` flavor), or `NewSlot` with `instanceNumber: null` and `registeredName: baseName`. The service's existing translation from `AtCapacity` to error text fans out on the singleton-vs-pool flag to produce either the "already active" message or the "at capacity" message; the allocator just reports the facts.

**Liveness moves out of storage but stays in core.** `isAgentActive` already lives in `core/utils.ts`. The allocator depends on a smaller predicate shaped exactly for its needs (`pid: number | null`, `last_seen_at: number`, `now: number`) rather than an `Agent`. The service injects `isProcessAlive`-plus-`PID_STALE_MS` as that predicate, keeping the allocator trivially testable with stubs. `SqliteAgentRepo` stops importing `isProcessAlive` and `PID_STALE_MS` entirely.

**One new port method, replacing `registerWithProfile`.** The `AgentRepository` port loses `registerWithProfile` and gains a single method that opens a write transaction scoped to a single base name and invokes a caller-supplied callback. The callback receives an opaque transactional session object exposing two operations: read the existing instances for the base name (returning the minimal projection the allocator consumes), and upsert the chosen agent row (taking `registeredName`, `pid`, `baseName`, and the profile fields). The callback returns whatever the service needs to assemble its `RegisterResult`. The adapter wraps the callback's body in `db.transaction(...).exclusive()` and the whole call in `withRetrySync()` — same retry envelope, same lock mode, same lifetime as today.

The session object is the seam. Core sees it as a structural type with two methods. The adapter implements it as a small inline class that closes over the `Database` handle. No `bun:sqlite` types cross the boundary. No SQL crosses the boundary. The two operations are deliberately tight: the read returns only the columns the allocator needs; the write is a single upsert matching the existing `_upsertAgent` semantics. That keeps the transaction short (no async, no extra round-trips beyond what `registerWithProfile` already does today) and respects the SQLite-concurrency rules in CLAUDE.md.

**The service orchestrates registration end-to-end.** `MessagingService.register` is rewritten so that, on profile match, it: (1) resolves the profile via `ProfileRepository`, (2) opens the transactional session via the new port method, (3) calls the allocator with the session's read result, (4) translates `AtCapacity` to the existing error text and throws, (5) calls the session's upsert with the allocator's decision, (6) returns the new row. The singleton/pool branching that today exists in two places (the service decides profile-vs-no-profile; the repo decides singleton-vs-pool *inside* the profile path) collapses into one place — the allocator.

The "suffixed namespace reservation" check (Decision #14 of the profile spec) stays in the service exactly where it is today. It's not slot policy; it's a guard against unprofiled names colliding with profiled pools. Moving it would be out of scope.

**Storage adapter, after the cut.** `SqliteAgentRepo` retains `findById`, `findByBaseName`, `register`, `heartbeatOrReclaim`, `listAll`, `clearPid`, and the private `_upsertAgent` helper. It gains the transactional-session port method. It loses `registerWithProfile` entirely. The `extractInstanceNumber` helper at the bottom of the file moves to `core/profiles/` next to the allocator — that's a parsing convention for the `{base}-{n}` registered-name format, which is core's convention, not storage's.

**Invariants.** (1) Read of existing instances and write of the chosen slot happen under one `.exclusive()` transaction; concurrent registrations either retry-and-converge or one of them gets `AtCapacity`. (2) The allocator is deterministic given its inputs — no clock reads, no liveness probes inside, both injected. (3) The instance-number numbering convention (`{base}-{n}`, n >= 1) lives in core; the registered name format is core's responsibility. (4) Error message text for at-capacity remains byte-identical to today's message so that existing tests asserting `/capacity/i` and existing operators who grep logs don't churn. (5) Singleton collision error message remains byte-identical (`/already active/i`).

**No DB schema change.** No migration. No on-disk format change. The agent table is untouched. The `idx_agents_base_name` index introduced by the profiles spec continues to serve the same query.

## Testing Decisions

The allocator gets its own test module under `tests/hex/core/` (name: `pool-slot-allocator.test.ts`). Tests are pure: build a synthetic list of `{ id, pid, last_seen_at }` records, build a stub `isAlive` predicate, call the allocator, assert the `SlotDecision`. Good tests assert external behavior — given these existing instances and this caller PID, the allocator returns this decision. They do not assert internal data structures or call order. Coverage targets: singleton happy path, singleton collision (alive different PID), singleton same-PID idempotency, singleton stale reclaim, pool first slot, pool same-PID idempotency, pool reclaim of lowest dead slot when holes exist mid-range, pool fill of next unused slot when only the high end is free, pool at-capacity, pool numbering density preserved across mixed live/dead/own input.

`tests/hex/storage/agent-repo.test.ts` loses its `registerWithProfile` describe block (~180 lines covering singleton, pool first slot, dead-slot reclaim, ascending fill, idempotency, capacity, singleton collision). Those cases all migrate to the allocator tests, where they're cheaper to run and read. What stays in agent-repo tests: `findById`, `findByBaseName`, `register` (non-profile path), `heartbeatOrReclaim`, `listAll`, `clearPid`, and a small new test for the transactional-session port method that verifies it opens an exclusive transaction and the read/write operations roundtrip.

`tests/hex/core/profile-registration.test.ts` keeps its existing scope — it's a service-level test that already drives `MessagingService.register` through the full registration story (profile lookup, allocation, persistence, auto-join). The same assertions should pass unchanged: same registered names, same instance numbers, same DB rows, same `RegisterResult` shape. If they don't, the refactor has changed behavior and the refactor is wrong.

`tests/hex/core/profile-concurrency.test.ts` is the load-bearing cross-process test (singleton race, pool race, base-name mention delivery across processes via the poller). It must pass unchanged. It is the contract that the transaction boundary still protects the policy — moving the policy across the seam should leave the race behavior untouched.

`tests/messaging/register.test.ts` is the non-profile registration test; it's untouched by this work but should pass unchanged. The architecture boundary test `tests/architecture/hexagonal-boundaries.test.ts` should remain green; it will additionally verify (or can be tightened to verify) that storage no longer imports `isProcessAlive` or `PID_STALE_MS`.

## Out of Scope

- Any on-disk schema change. No migration. The agents table is untouched.
- Profile YAML format changes. Profile loading, `ProfileRepository`, `YamlProfileStore` — all untouched.
- The notification dispatcher and the cross-process poller. They observe the results of registration (live instances of `base_name`) but don't see the allocation policy.
- The suffixed-namespace reservation check (Decision #14). It stays in the service unchanged; it's not slot policy.
- Auto-join channel behavior. Same code path, same error handling.
- The `register` (non-profile) path. Same behavior, same tests.
- A reclaim-ordering policy change. We preserve today's "lowest dead slot first" rule. If that needs to become "oldest by `last_seen_at`", that is a follow-up change to a single allocator function — exactly the kind of edit this refactor exists to make cheap.
- A second storage adapter. The boundary cleanup is the prerequisite, not the goal.

## Further Notes

This refactor concentrates profile policy. After it lands, anyone reading "what does pool registration do?" reads `src/core/profiles/` end-to-end — types, allocator, registered-name parsing — and `MessagingService.register`. Anyone reading "how does pool registration persist?" reads `src/storage/sqlite/agent-repo.ts` and finds row CRUD plus one transactional-session method.

The most subtle thing the design preserves is the transaction shape. It would be tempting to make the allocator drive the transaction (call repo to read, decide, call repo to write — two separate calls). That breaks the race-free guarantee: between the read and the write, another process can claim the same slot. The callback-scoped session keeps the read and write inside one `.exclusive()` lock. The seam is deliberately ugly in one specific way — core asks the adapter "let me operate inside your transaction" — and that ugliness is the entire reason the refactor is safe.

Adjacent specs worth re-reading after this lands: `docs/specs/2026-04-12-persistent-agent-profiles-design.md` (section 7.5 on race condition handling — preserved verbatim); `docs/specs/2026-04-03-sqlite-concurrency-at-scale.md` (the design rules the new port method must honor); `docs/specs/2026-04-04-hexagonal-architecture-design.md` (the boundary discipline that motivates the move).

Follow-ups not covered by this PRD:
- Tighten the boundary test so a storage adapter importing `isProcessAlive` or `PID_STALE_MS` becomes a failing test, not a code-review catch.
- Consider relocating the few remaining domain-aware checks in storage (e.g. the stale-reclaim branch inside `register` and `heartbeatOrReclaim`) using the same transactional-session pattern. Out of scope here; the pool-slot allocator is the deepest of the three and gets the first cut.
