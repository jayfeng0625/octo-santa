// src/contracts/index.ts
//
// The thin-core product seam (NORMATIVE spec 2026-06-02-thin-core-contracts.md §1, §2).
// The interface IS the product: octo-santa is ONE implementation behind a
// transport-agnostic seam (`PubSub` + `PeerDiscovery`). Today's SQLite is the first
// adapter; a future Cloudflare/distributed backend is another.
//
// PURE TYPES. Zero runtime deps. Zero infrastructure imports (no src/storage,
// src/transports, src/notifications, bun:sqlite, @modelcontextprotocol/*).

// --- Branded opaque ids (spec §1 B, §5 B) ---
// Opaque, backend-assigned. Consumers NEVER construct or parse — round-trip only.
// Mint helpers are adapter-internal; the brand makes a raw-literal a COMPILE error.
export type PeerId = string & { readonly __brand: "PeerId" };
export type Cursor = string & { readonly __brand: "Cursor" };

/** Adapter-internal mint. Consumers must never call this — round-trip ids only. */
export const asPeerId = (s: string): PeerId => s as PeerId;
/** Adapter-internal mint. Consumers must never call this — round-trip ids only. */
export const asCursor = (s: string): Cursor => s as Cursor;

// --- Message ---
export interface Message {
  readonly topic: string;
  /** Publisher identity (spec §2.1: identity bound at construction, OD-1). */
  readonly from: PeerId;
  /**
   * UTF-8 text payload (spec §2.8, α). No binary in Phase A — binary, when needed,
   * arrives via a future `metadata.content-type`, never by overloading `data`.
   * `string` → `string | Uint8Array` is a non-breaking widening.
   */
  readonly data: string;
  /**
   * The id of THIS message (spec §2.5, γ-1). Opaque. A consumer gets it from a
   * delivered Message and may hand it back to `replayFrom`. It NEVER constructs
   * or parses one.
   */
  readonly cursor: Cursor;
}

export type OnMessage = (msg: Message) => void | Promise<void>;

// --- Capability descriptor (machine-checkable; gates conformance sections, spec §3) ---
export interface CapabilityDescriptor {
  /** Survives process restart / works cross-process. */
  readonly durable: boolean;
  /** Can re-read from a cursor via `replayFrom`. */
  readonly replayable: boolean;
  readonly delivery: "at-least-once" | "at-most-once";
  /** 2 values only — no speculative third (spec §1 D). */
  readonly topicLifecycle: "implicit" | "explicit";
}

// --- PubSub (thin) ---
/**
 * Constructed for ONE peer identity (spec §2.1, OD-1) — no per-call identity override.
 *
 * Invariants honored by EVERY impl regardless of descriptor:
 * - **Per-topic FIFO ordering (spec §2.3):** messages within a topic are delivered in
 *   publish order. Cross-topic ordering is NOT guaranteed.
 * - **Encoding (spec §2.8, α):** `data` is UTF-8 text. No binary in Phase A.
 * - **No explicit backpressure (spec §2.9, C — deferred):** flow control is implicit;
 *   an adapter MAY slow its delivery cycle by awaiting `onMessage`.
 */
export interface PubSub {
  readonly capabilities: CapabilityDescriptor;

  /**
   * Publish UTF-8 `data` to `topic`.
   *
   * Topic existence is `topicLifecycle`-defined (spec §2.2, D): for `"implicit"` impls
   * an unknown topic is auto-created (empty, zero replay) and is NEVER an error; for
   * `"explicit"` impls an unknown topic is REJECTED. Consumers branch on
   * `capabilities.topicLifecycle`, never assume.
   */
  publish(topic: string, data: string): Promise<void>;

  /**
   * Stateful, cursor-advancing delivery (spec §2.4).
   * - Delivers forward from the subscriber's cursor. A brand-new subscriber's cursor = 0
   *   → it receives the FULL backlog (catch-up), then live messages.
   * - Re-`subscribe` to an already-active topic REPLACES the handler; cursor unchanged.
   *
   * Ack/nack model (spec §2.7, gated on `delivery`):
   * - `onMessage` resolves = ACK → cursor advances past the message.
   * - `onMessage` throws/rejects = NACK → cursor holds.
   * - Redelivery trigger = NEXT delivery cycle, NOT synchronous retry (a permanently
   *   throwing handler must not tight-loop). The cursor simply does not advance, so the
   *   message reappears on the next cycle (next publish for push impls / next poll tick
   *   for poll impls), read forward from the unadvanced cursor.
   * - Head-of-line (HOL) block: the cursor cannot advance past a NACKed message N, so
   *   N+1 is not delivered until N ACKs. Single cursor + FIFO force this. No DLQ, no
   *   skip-ahead in Phase A.
   * - At-least-once: consumers MUST tolerate duplicate delivery — idempotency is the
   *   CONSUMER's job.
   * - POISON-PILL (KNOWN Phase-A limitation): an `onMessage` that ALWAYS throws wedges
   *   that subscriber's topic at N forever — there is no escape hatch in Phase A.
   *   Consumers MUST be idempotent AND must not throw indefinitely. "DLQ /
   *   skip-after-N-retries" is a NAMED future capability (defer ≠ forget).
   *
   * Topic existence is `topicLifecycle`-defined (spec §2.2), same as `publish`.
   */
  subscribe(topic: string, onMessage: OnMessage): Promise<void>;

  /**
   * Stop-only (spec §2.4, OD-3): stops delivery; cursor + membership PERSIST.
   * Re-`subscribe` RESUMES from the held cursor (does NOT replay from 0).
   */
  unsubscribe(topic: string): Promise<void>;

  /**
   * Stateless one-shot read, STRICTLY AFTER `cursor` (spec §2.6, γ-2, exclusive).
   * Forward read; does NOT advance any subscription cursor; does NOT self-exclude.
   * Distinct from `subscribe`: replay never mutates subscription state. `cursor` is an
   * opaque id obtained from a delivered Message — never constructed by the consumer.
   */
  replayFrom(topic: string, cursor: Cursor, onMessage: OnMessage): Promise<void>;
}

// --- PeerDiscovery (thin, segregated) ---
/**
 * Segregated from `PubSub`. An adapter object MAY implement both (the SQLite adapter
 * does, over one DB) — composition is the impl's choice; the interfaces stay separate.
 */
export interface PeerDiscovery {
  /** Active/known peers on the backplane. */
  list(): Promise<readonly PeerId[]>;
}
