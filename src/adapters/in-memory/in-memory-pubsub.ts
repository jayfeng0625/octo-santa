// src/adapters/in-memory/in-memory-pubsub.ts
//
// InMemoryPubSub — the first/reference implementation behind the thin-core seam
// (NORMATIVE spec 2026-06-02-thin-core-contracts.md §2, §3, §4).
//
// In-process, ephemeral. Declares:
//   { durable: false, replayable: true, delivery: "at-least-once", topicLifecycle: "implicit" }
//
// A shared BACKPLANE (registry object) holds per-topic ordered logs, per-(peer,topic)
// cursors, per-(peer,topic) subscriber handlers, and the set of known peers. A PubSub +
// PeerDiscovery pair is BOUND TO ONE peer identity at construction (OD-1, spec §2.1).
// Multiple peers share one backplane instance.

import {
  asPeerId,
  asCursor,
  type PeerId,
  type Cursor,
  type Message,
  type OnMessage,
  type PubSub,
  type PeerDiscovery,
  type CapabilityDescriptor,
} from "../../contracts";

const DESCRIPTOR: CapabilityDescriptor = {
  durable: false,
  replayable: true,
  delivery: "at-least-once",
  topicLifecycle: "implicit",
};

/** A single stored message on a topic log. `id` is the monotonic per-topic cursor value. */
interface LogEntry {
  readonly id: number;
  readonly message: Message;
}

/** Per-(peer,topic) subscription state. */
interface Subscription {
  onMessage: OnMessage;
  /** Last ACKed message id on this topic; 0 = nothing acked yet (full backlog). */
  cursor: number;
  /** Re-entrancy guard so a cycle triggered mid-cycle doesn't double-deliver. */
  draining: boolean;
  /**
   * Set when a drain was suppressed by the re-entrancy guard while an outer drain was
   * suspended at `await onMessage`. The outer drain re-checks the log once more in its
   * `finally` so the suppressed cycle (a publish that would otherwise be stranded) is not
   * lost — including across a NACK-break (spec §2.7: at-least-once redelivery on the next
   * cycle).
   */
  pending: boolean;
}

/** Per-topic state: ordered log + monotonic id counter. */
interface TopicState {
  readonly log: LogEntry[];
  nextId: number;
  /** subscriptions keyed by peer id. */
  readonly subscriptions: Map<PeerId, Subscription>;
}

/**
 * The shared in-memory backplane. A fresh instance per `createBackplane()` call —
 * NOT a process-global singleton, so parallel test files never cross-contaminate
 * (spec §4: hermetic per-factory backplane).
 */
export interface Backplane {
  readonly topics: Map<string, TopicState>;
  readonly peers: Set<PeerId>;
  /** Held per-(peer,topic) cursors that survive unsubscribe (stop-only, spec §2.4). */
  readonly heldCursors: Map<PeerId, Map<string, number>>;
}

export function createBackplane(): Backplane {
  return {
    topics: new Map(),
    peers: new Set(),
    heldCursors: new Map(),
  };
}

function topicOf(bp: Backplane, topic: string): TopicState {
  let t = bp.topics.get(topic);
  if (!t) {
    // Implicit auto-create (spec §2.2): unknown topic is never an error.
    t = { log: [], nextId: 1, subscriptions: new Map() };
    bp.topics.set(topic, t);
  }
  return t;
}

function heldCursor(bp: Backplane, peer: PeerId, topic: string): number {
  return bp.heldCursors.get(peer)?.get(topic) ?? 0;
}

function setHeldCursor(bp: Backplane, peer: PeerId, topic: string, value: number): void {
  let m = bp.heldCursors.get(peer);
  if (!m) {
    m = new Map();
    bp.heldCursors.set(peer, m);
  }
  m.set(topic, value);
}

/**
 * Mint an opaque cursor for `(topic, entryId)`. Cursors are per-topic-scoped (spec §2.5:
 * a Message.cursor is the id of THAT message on THAT topic). The topic is length-prefixed
 * so parsing is unambiguous for any topic string. Consumers NEVER parse this — it is
 * round-tripped back to `replayFrom`, which uses `parseCursor` to bind it to its topic.
 */
function mintCursor(topic: string, entryId: number): Cursor {
  return asCursor(`${topic.length}:${topic}:${entryId}`);
}

/**
 * Parse a cursor minted by `mintCursor`, returning the entry id ONLY if the cursor is
 * well-formed AND belongs to `topic`. Returns null otherwise — a foreign-topic cursor or a
 * non-integer/foreign-shaped cursor is rejected by `replayFrom`, never silently mapped by
 * numeric position (the contract says cursors are opaque + per-topic-scoped, spec §2.5/§2.6).
 */
function parseCursor(topic: string, cursor: Cursor): number | null {
  const raw = cursor as string;
  const sep = raw.indexOf(":");
  if (sep < 0) return null;
  const len = Number(raw.slice(0, sep));
  if (!Number.isInteger(len) || len < 0) return null;
  const cursorTopic = raw.slice(sep + 1, sep + 1 + len);
  if (cursorTopic !== topic) return null; // foreign-topic cursor → rejected
  if (raw[sep + 1 + len] !== ":") return null;
  const idStr = raw.slice(sep + 1 + len + 1);
  const id = Number(idStr);
  if (idStr === "" || !Number.isInteger(id)) return null;
  return id;
}

/**
 * Drain a subscription forward from its cursor: deliver the next message, await the
 * handler, ACK→advance cursor, NACK→hold (HOL). Redelivery is NEXT-cycle only —
 * a NACK stops the drain; it does not synchronously retry (spec §2.7).
 */
async function drain(bp: Backplane, t: TopicState, peer: PeerId, sub: Subscription): Promise<void> {
  if (sub.draining) {
    // A drain is already in flight (the outer drain is suspended at `await onMessage`).
    // Mark a re-check so the outer drain re-runs once more in its `finally` — otherwise an
    // overlapping publish is silently swallowed and, on a NACK-break, the next message is
    // stranded and redelivery stalls (at-least-once violation, spec §2.7).
    sub.pending = true;
    return;
  }
  sub.draining = true;
  try {
    // Re-runs while a suppressed overlapping cycle was recorded. A persistent NACK does not
    // advance the cursor and does not set `pending` (it breaks synchronously, not mid-await),
    // so this re-check delivers the stranded message / re-attempts the NACKed one exactly
    // once without tight-looping a poison pill.
    do {
      sub.pending = false;
      // Loop forward over the log; stop on the first NACK (HOL block).
      while (true) {
        const next = t.log.find((e) => e.id > sub.cursor);
        if (!next) break;
        try {
          await sub.onMessage(next.message);
        } catch {
          // NACK → cursor holds; redelivery happens on the NEXT cycle. Stop draining.
          break;
        }
        // ACK → advance past this message.
        sub.cursor = next.id;
        setHeldCursor(bp, peer, next.message.topic, sub.cursor);
      }
    } while (sub.pending);
  } finally {
    sub.draining = false;
  }
}

/** A PubSub + PeerDiscovery pair bound to one peer identity over a shared backplane. */
export interface Peer {
  readonly id: PeerId;
  readonly pubsub: PubSub;
  readonly discovery: PeerDiscovery;
}

export async function connectInMemoryPeer(bp: Backplane, name: string): Promise<Peer> {
  // Adapter brands the PeerId at the registration boundary (spec §4, B).
  const id = asPeerId(name);
  bp.peers.add(id);

  const pubsub: PubSub = {
    capabilities: DESCRIPTOR,

    async publish(topic, data) {
      const t = topicOf(bp, topic);
      const entryId = t.nextId++;
      const message: Message = {
        topic,
        from: id, // publisher identity (OD-1)
        data,
        cursor: mintCursor(topic, entryId), // cursor on a Message = id of THAT message (γ-1)
      };
      t.log.push({ id: entryId, message });
      // #28 (decouple): snapshot the subscriber set BEFORE fan-out — concurrent
      // (un)subscribe during a handler await must not mutate the iteration — and deliver to
      // each subscriber INDEPENDENTLY (no serial await). publish() resolution must NOT depend
      // on any handler's outcome: a slow/hung subscriber must not wedge publish() or starve
      // co-subscribers. Per-subscriber drain() still owns FIFO + at-least-once + the
      // re-entrancy/`pending` guard (so an overlapping publish is never stranded).
      for (const [peer, sub] of [...t.subscriptions]) {
        // `void` is safe ONLY because drain() contains ALL handler errors (sync throw AND
        // async reject are caught → NACK), so this floating promise never rejects — it only
        // pends (hung handler) or resolves. LOAD-BEARING: if drain() ever throws OUTSIDE the
        // handler-catch, add a `.catch` here or it becomes an unhandled rejection.
        void drain(bp, t, peer, sub);
      }
    },

    async subscribe(topic, onMessage) {
      const t = topicOf(bp, topic);
      const existing = t.subscriptions.get(id);
      if (existing) {
        // Re-subscribe to an active topic: replace handler, cursor unchanged (spec §2.4).
        existing.onMessage = onMessage;
      } else {
        // New or resumed subscription: resume from held cursor (0 for brand-new → full backlog).
        const sub: Subscription = {
          onMessage,
          cursor: heldCursor(bp, id, topic),
          draining: false,
          pending: false,
        };
        t.subscriptions.set(id, sub);
        await drain(bp, t, id, sub);
      }
    },

    async unsubscribe(topic) {
      // Stop-only (spec §2.4): drop the handler; cursor + membership persist via heldCursors.
      const t = bp.topics.get(topic);
      const sub = t?.subscriptions.get(id);
      if (sub) {
        setHeldCursor(bp, id, topic, sub.cursor);
        t!.subscriptions.delete(id);
      }
    },

    async replayFrom(topic, cursor, onMessage) {
      // Stateless one-shot read STRICTLY AFTER cursor (γ-2, exclusive). Does NOT advance
      // any subscription cursor; does NOT self-exclude (spec §2.6). Non-creating lookup:
      // a "stateless read" must not mutate state, so a never-seen topic yields nothing
      // (no implicit auto-vivify — unlike publish/subscribe).
      //
      // Cursors are opaque + per-topic-scoped (spec §2.5): a cursor not minted for THIS
      // topic (foreign-topic) or not well-formed (non-integer / foreign-shaped) is REJECTED
      // rather than silently mapped by numeric position into an unrelated slice.
      const after = parseCursor(topic, cursor);
      if (after === null) {
        throw new Error("cursor is not from this topic on this backend");
      }
      const t = bp.topics.get(topic);
      if (!t) return;
      for (const e of t.log) {
        if (e.id > after) {
          await onMessage(e.message);
        }
      }
    },
  };

  const discovery: PeerDiscovery = {
    async list(): Promise<readonly PeerId[]> {
      return [...bp.peers];
    },
  };

  return { id, pubsub, discovery };
}
