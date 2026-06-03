# Spec: Thin-Core Contracts (Phase A) — Normative

> Status: NORMATIVE — single source of truth for Phase A contracts
> Date: 2026-06-02
> Scope: Phase A only — `src/contracts/index.ts` + `src/adapters/in-memory/` + conformance suite. NO SQLite adapter (Phase B, blocked on Gaps #1–3).
> Derived from: os-rewrite grill (msgs 2541–2568) + assessment `docs/specs/2026-06-01-thin-core-retrofit-assessment.md`.
> Governs: issue creation (`/to-issues`) + the `ultracode` implementation workflow. If code and this spec disagree, this spec wins until amended in-channel.

The interface IS the product. octo-santa becomes ONE implementation behind a transport-agnostic seam (`PubSub` + `PeerDiscovery`). Today's SQLite is the first adapter; a future Cloudflare/distributed backend is another. The seam is proven real by a single conformance suite both impls pass.

---

## 1. Interfaces (`src/contracts/index.ts`)

Pure types. ZERO runtime deps. ZERO infrastructure imports (no `src/storage/`, `src/transports/`, `src/notifications/`, `bun:sqlite`, `@modelcontextprotocol/*`).

```ts
// --- Branded opaque ids (B) ---
// Opaque, backend-assigned. Consumers NEVER construct or parse — round-trip only.
// Mint helpers are adapter-internal; the brand makes a raw-literal a COMPILE error.
export type PeerId = string & { readonly __brand: 'PeerId' };
export type Cursor = string & { readonly __brand: 'Cursor' };
export const asPeerId = (s: string): PeerId => s as PeerId;   // adapter-internal mint
export const asCursor = (s: string): Cursor => s as Cursor;   // adapter-internal mint

// --- Message ---
export interface Message {
  readonly topic: string;
  readonly from: PeerId;      // publisher identity
  readonly data: string;      // UTF-8 text (α). Binary later via metadata.content-type — NOT Phase A.
  readonly cursor: Cursor;    // id of THIS message (γ-1). Opaque; hand back to replayFrom, never mint.
}

export type OnMessage = (msg: Message) => void | Promise<void>;

// --- Capability descriptor (machine-checkable; gates conformance sections) ---
export interface CapabilityDescriptor {
  readonly durable: boolean;                         // survives process restart / cross-process
  readonly replayable: boolean;                      // can re-read from a cursor
  readonly delivery: 'at-least-once' | 'at-most-once';
  readonly topicLifecycle: 'implicit' | 'explicit';  // 2 values only — no speculative third (D)
}

// --- PubSub (thin) ---
export interface PubSub {
  readonly capabilities: CapabilityDescriptor;
  publish(topic: string, data: string): Promise<void>;
  subscribe(topic: string, onMessage: OnMessage): Promise<void>;
  unsubscribe(topic: string): Promise<void>;                       // stop-only (OD-3)
  replayFrom(topic: string, cursor: Cursor, onMessage: OnMessage): Promise<void>;
}

// --- PeerDiscovery (thin, segregated) ---
export interface PeerDiscovery {
  list(): Promise<readonly PeerId[]>;   // active/known peers on the backplane
}
```

An adapter object MAY implement both interfaces (the SQLite adapter does, over one DB). The interfaces stay segregated; composition is the impl's choice. No `context?` param (A — deferred to Phase C, see §7).

---

## 2. Normative semantics

These are CONTRACT TEXT. Both InMemory and SQLite MUST honor them identically, or the conformance suite is a lie.

1. **Identity bound at construction (OD-1).** A `PubSub` is constructed for ONE peer identity. No per-call identity override.

2. **Topic existence is `topicLifecycle`-defined (D).** For `topicLifecycle:"implicit"` impls, `publish` AND `subscribe` to an unknown topic BOTH auto-create it (empty, zero replay); unknown topic is NEVER an error. For `"explicit"` impls, unknown topic is REJECTED and topics are created out-of-band. Consumers branch on `topicLifecycle`, never assume. **octo-santa's hybrid is across ENTRYPOINTS, not the seam:** `directMessage` auto-creates (service.ts:332), but the seam's `publish` maps to `messaging.send` (OD-8), which THROWS on unknown (service.ts:227). So the SQLite adapter is uniformly `topicLifecycle:"explicit"` — a faithful mirror of `send` that adds no policy (matches "adapter wraps service, adds no policy"). Consequence: DM-style auto-create is NOT reachable through the seam's `publish` (DM topics pre-exist or are made via the existing `directMessage`/`createChannel` path); DM-auto-create-through-`publish` is a NAMED future enhancement (§6), not a silent gap.

3. **Per-topic FIFO ordering (invariant, all impls).** Messages within a topic are delivered in publish order. This is a contract invariant, not a descriptor field. (Cross-topic ordering is NOT guaranteed.)

4. **`subscribe` = stateful, cursor-advancing delivery.**
   - Delivers forward from the subscriber's cursor. A brand-new subscriber's cursor = 0 → it receives the FULL backlog (catch-up), then live messages. *(Product-observable — see fidelity flag in §6.)*
   - `unsubscribe` is stop-only: cursor + membership persist; re-`subscribe` RESUMES from the held cursor (does not replay from 0).
   - Re-`subscribe` to an already-active topic replaces the handler; cursor unchanged.

5. **`cursor` on a Message = the id of THAT message (γ-1).** Opaque AND per-topic-scoped. A consumer gets it from a delivered Message and may hand it to `replayFrom`. It NEVER constructs or parses one. A cursor is bound to the topic of the Message it came from: handing topic X's cursor to `replayFrom(topicY, …)` is NOT a valid round-trip. Every impl MUST bind cursors to their topic (the InMemory reference encodes the topic into the cursor; the SQLite adapter MUST be held to the same rule in Phase B).

6. **`replayFrom(topic, cursor)` = stateless one-shot read, STRICTLY AFTER cursor (γ-2, exclusive).** Forward read; does NOT advance any subscription cursor; does NOT self-exclude. Maps to the future Gap #3 `replayMessages`. Distinct from `subscribe`: replay never mutates subscription state. A cursor that was not minted for `topic` (foreign-topic), or that is not well-formed for this backend (non-integer / foreign-shaped), is REJECTED (throws) — it is NEVER silently mapped by numeric position into an unrelated slice. An in-range, same-topic cursor whose id is at or beyond the log end yields an empty read (nothing strictly after it).

7. **At-least-once delivery (gated on `delivery`).** Consumers MUST tolerate duplicate delivery; idempotency is the CONSUMER's job. Mechanics:
   - **Ack model:** `onMessage` resolves = ACK → cursor advances past the message. `onMessage` throws/rejects = NACK → cursor holds.
   - **Redelivery trigger = next delivery cycle, NOT synchronous retry.** A NACKed message is NOT re-invoked immediately (a permanently-throwing handler would tight-loop and wedge the process). The cursor simply does not advance, so the message reappears on the next cycle: next `publish` to the topic (push impls) or next poll tick (poll impls). Redelivery reads forward from the unadvanced cursor.
   - **Head-of-line (HOL) block.** The cursor cannot advance past a NACKed message N → N+1 is not delivered until N ACKs. Single cursor + FIFO ordering force this. No DLQ, no skip-ahead in Phase A.
   - **Poison-pill constraint (KNOWN Phase-A limitation, documented not silently shipped):** an `onMessage` that ALWAYS throws wedges that subscriber's topic at N forever — there is no escape hatch in Phase A. Consumers MUST be idempotent AND must not throw indefinitely. "DLQ / skip-after-N-retries" is a NAMED future capability (defer ≠ forget — see §7).

8. **Encoding (α / OD-6).** `data` is UTF-8 text. No binary in Phase A. Binary, when needed, arrives via a future `metadata.content-type`, never by overloading `data`. `string` → `string | Uint8Array` is a non-breaking widening.

9. **Backpressure (C — deferred).** No explicit backpressure signal. Flow control is implicit: an adapter MAY slow its delivery cycle by awaiting `onMessage`. Documented limitation.

---

## 3. Capability descriptor + conformance gating

The descriptor earns its place by letting backends legitimately differ; the suite reads it to decide which sections run. Gating axes:

| Axis | Gates | InMemory | SQLite (Phase B) |
|---|---|---|---|
| `durable` | cross-process / restart persistence + crash-recovery redelivery | `false` (skips) | `true` (proves) |
| `replayable` | `replayFrom` re-read from cursor | `true` | `true` |
| `delivery` | at-least-once redelivery (ack/nack, next-cycle, HOL) | `"at-least-once"` (runs) | `"at-least-once"` (runs) |
| `topicLifecycle` | unknown-topic auto-create vs reject | `"implicit"` | `"explicit"` (publish=send, OD-8) |

**InMemory descriptor = `{ durable: false, replayable: true, delivery: "at-least-once", topicLifecycle: "implicit" }`.**

Key split (architect ruling, msg 2561): at-least-once is ORTHOGONAL to durability. InMemory runs the at-least-once + replay sections in Phase A (proving Gaps #1/#3 semantics against a reference impl BEFORE SQLite). Only `durable` (cross-process/restart survival) gates out for InMemory; SQLite newly proves it in Phase B.

---

## 4. Conformance suite (β) — Phase A definition-of-done

The suite is the contractual proof a backend "is octo-santa." It is parameterized over a harness factory and validates the SAME behaviors against every impl. SQLite's factory slots in UNCHANGED at Phase B.

**Scope of "UNCHANGED" — delivery timing is push-impl-specific (Phase A).** The Phase A suite's wait primitive (`flush()` = two microtask awaits) and its at-least-once redelivery trigger (a *subsequent publish* drives the next cycle) assume SYNCHRONOUS in-process push delivery — true of the InMemory reference impl. The "this file does not change at Phase B" claim therefore holds for PUSH impls. A POLL-based backend (SQLite, future Cloudflare) delivers on a poller TICK (a real timer), and a subsequent `publish` in one logical peer does not synchronously drive a different-process subscriber's next tick (§2.7: redelivery = "next publish (push impls) or next poll tick (poll impls)"; CLAUDE.md: cross-process delivery requires polling). When the first poll-based adapter lands, the suite's `flush()` is replaced by a time-tolerant settle primitive (e.g. `until(pred, {timeoutMs})`) and/or the harness gains an `advance()`/`tick()` seam, and the at-least-once redelivery trigger is re-parameterized to a tick — the asserted BEHAVIORS (cross-peer delivery, FIFO, catch-up, redelivery, HOL, duplicate-tolerance) are unchanged. There is intentionally no delivery-timing descriptor axis and no tick seam in Phase A (descriptor locked to 4 axes per §1 D "no speculative third"; harness shape ratified by R6). This is a named Phase B re-parameterization, not a silent gap.

```ts
// factory() creates a FRESH, hermetic backplane INSTANCE (NOT a process-global singleton —
// parallel test files must not cross-contaminate). connect() mints peers bound to THAT backplane.
export interface Peer {
  readonly id: PeerId;          // branded; adapter mints from the plain name at the registration boundary
  readonly pubsub: PubSub;
  readonly discovery: PeerDiscovery;
}
export interface ConformanceHarness {
  connect(name: string): Promise<Peer>;   // plain string in; adapter brands internally (suite never mints)
  cleanup(): Promise<void>;                // disposes THIS backplane instance
  /**
   * DURABLE backends only (the durable-gated test is the sole caller). Simulates a process
   * restart: drop all live connections/peers but PRESERVE the backing store, returning a
   * harness over the SAME store. Non-durable impls (`durable:false`, e.g. InMemory) OMIT it
   * — the durable test is skipped for them, so it is never called. This is the restart seam
   * that lets the durable axis be proven through the SAME suite in Phase B with ZERO
   * harness-shape change (resolves Finding A — no false-passing durable stub).
   */
  reopen?(): Promise<ConformanceHarness>;
}
export type HarnessFactory = () => Promise<ConformanceHarness>;
```

**Why a harness, not `{pubsub, cleanup}` (architect amendment R6, RATIFIED msg 2571):** the CORE suite must validate CROSS-PEER delivery — peer A publishes, peer B (a DIFFERENT identity on the SAME backplane) receives — because multi-agent delivery is octo-santa's essence (CLAUDE.md: agent-to-agent must work across processes). A single returned `pubsub` yields one identity and can only test single-peer loopback, which also can't satisfy the CORE "peer list" test (needs ≥2 peers). The harness mints N peers on one backplane; `cleanup` disposes it. Each `factory()` call yields a FRESH backplane INSTANCE (hermetic — not a process-global singleton, so parallel `bun test` files can't cross-contaminate): InMemory = a registry object, SQLite Phase B = a per-invocation temp DB. `connect(name)` takes a PLAIN string; the adapter brands the `PeerId` at the registration boundary (so the suite never constructs a branded literal — B); the returned `Peer.id` is the branded id used for round-trip assertions (e.g. `msg.from === A.id`). True cross-PROCESS (separate OS processes) is part of the `durable`-gated section in Phase B.

**CORE section (all impls):**
- Cross-peer delivery: A `publish(t, x)` → B (subscribed to `t`) `onMessage` fires with `from === A.id`.
- Per-topic FIFO ordering.
- Race-free delivery: `subscribe(t)` then `publish(t, x)` → `onMessage` fires (no lost-update race), FIFO. Topic-existence-agnostic (auto-created by implicit impls, pre-created for explicit); the unknown-topic behavior itself is `topicLifecycle`-gated below.
- Catch-up: new subscriber on a topic with backlog receives from cursor 0, in order.
- `replayFrom` exclusivity: returns strictly-after the given cursor; does not advance subscription cursor.
- Peer list: `list()` returns connected peers.
- `unsubscribe` stop-only: re-subscribe resumes from held cursor, not 0.

**Descriptor-gated sections:**
- `topicLifecycle === "implicit"` → unknown-topic auto-create symmetry: `publish`/`subscribe` to a never-seen topic auto-creates it (empty, never error). InMemory runs this.
- `topicLifecycle === "explicit"` → unknown-topic rejection: `publish`/`subscribe` to an uncreated topic REJECTS. Mutually exclusive with the implicit branch. No explicit impl in Phase A (dormant); SQLite Phase B runs it — authored now so the suite is literally unchanged in Phase B.
- `delivery === "at-least-once"` → redelivery test: NACK (throw) → cursor holds → message redelivered on next cycle (cycle triggered deterministically by a subsequent `publish`, no sleeps); HOL (N blocks N+1); duplicate-tolerance asserted. Poison-pill HOL asserted as intended behavior.
- `durable === true` → cross-process/restart replay: publish, then `harness.reopen()` (simulate restart — drop connections, keep the backing store), reconnect a fresh peer, and assert the backlog SURVIVED. SKIPPED for InMemory (`durable:false`; reported skipped, not failed). SQLite proves it in Phase B via `reopen()` — zero harness-shape change. The test MUST exercise `reopen()`; a connect-then-subscribe catch-up (no restart) does NOT test durability and is a false-passing stub (Finding A — forbidden).

**Suite invariants:**
- The suite NEVER constructs a `Cursor`/`PeerId` literal (brand makes it a compile error) — it only round-trips ids obtained from Messages / `list()`.
- InMemory runs the suite GREEN: all CORE + at-least-once green; `durable` section reported skipped.

---

## 5. Locked decision ledger

| Item | Decision |
|---|---|
| A — `context?` param | DEFERRED to Phase C (B5 not a hard mandate). NOT in Phase A. Home = Strategic §5.A. |
| α — payload | `string` (UTF-8). Binary via future `metadata.content-type`. Widening = non-breaking. |
| B — opaque ids | Brand BOTH `PeerId` + `Cursor`. Shared mint helpers, adapter-internal. |
| γ — cursor | (1) Message.cursor = id of that message. (2) `replayFrom` strictly-after (exclusive). |
| β — conformance | Parameterized over `HarnessFactory`. CORE + descriptor-gated. = Phase A DoD. |
| C — backpressure | DEFER. Throttle via awaiting `onMessage`. No explicit signal. |
| D — topic lifecycle | DEFER via `topicLifecycle` descriptor field (2 values). InMemory implicit auto-create, unknown = empty never error; handling backend-defined. |
| at-least-once | Consumer idempotent. Ack/nack + next-cycle + HOL + documented poison-pill. |
| OD-1 | Identity bound at construction. |
| OD-7 | In-tree: `src/contracts/`, `src/adapters/`. Extract package when Cloudflare adapter lands. |
| OD-8 | @mention/hop/human policy internal to MessagingService; adapter `publish` omits `{human:true}` (Phase B). |

### Fidelity flag for os-pm (product-observable, was implicit)
**§2.4 catch-up-from-0:** a new subscriber receives the FULL backlog (cursor 0) then live, mirroring octo-santa's `cursors` default `last_read_message_id = 0`. Phase B fidelity check: if octo-santa's current `subscribe` sets the cursor to the channel HWM (live-only) rather than 0, the SQLite adapter MUST override to honor this contract. Confirm the intended product semantic.

### Architect amendment flag (changes a previously-locked detail)
**R6 (§4) — RATIFIED (msg 2571):** harness factory `() => Promise<{ connect(name)→Peer, cleanup }>` SUPERSEDES the earlier `() => Promise<{ pubsub, cleanup }>` so the CORE suite can validate cross-peer delivery + peer-list. Locked pins: (1) backplane = a fresh per-`factory()` INSTANCE, hermetic, not a process-global singleton; (2) `connect` takes a plain string, adapter brands the `PeerId` internally; (3) `Peer = { id: PeerId, pubsub: PubSub, discovery: PeerDiscovery }`, `connect` async.

---

## 6. Deferred / future (defer ≠ forget — Phase C named gates)

- **Auth/authz injection shape** (A / Strategic §5.A) — TYPED (token/tenant/sig), gated before the 2nd adapter cements `publish`/`subscribe` signatures.
- **Distributed `PeerId` shape** (Strategic §5.B) — branded string holds for single-backplane; cryptographic/namespaced identity for cross-tenant.
- **Backpressure / flow control** (C / Strategic §5.C).
- **Topic lifecycle for cost/quota backends** (D / Strategic §5.D) — `topicLifecycle:"explicit"` path.
- **DM-auto-create through the seam's `publish`** — `directMessage` auto-creates a DM topic, but `publish` maps to `send` (explicit, OD-8), so DM topics are not auto-created via `publish`. Named future enhancement if ever wanted; not a silent gap (§2.2).
- **DLQ / skip-after-N-retries** — escape hatch for the poison-pill HOL limitation (§2.7).
