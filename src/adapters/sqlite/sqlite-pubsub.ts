// src/adapters/sqlite/sqlite-pubsub.ts
//
// SQLite adapter behind the thin-core seam (NORMATIVE spec 2026-06-02-thin-core-contracts.md
// §2, §3, §4). The DURABLE, cross-process backend: octo-santa's messaging IS this adapter
// over the shared SQLite db.
//
// BOUNDARY (CLAUDE.md + archunit hexagonal-boundaries.test.ts:192): this adapter wraps the CORE
// domain service (MessagingService) and the src/contracts seam ONLY. It NEVER imports
// `src/storage` or `bun:sqlite` (adapters ↛ storage). Concrete SQLite repos are injected at
// the composition root / conformance harness, into the MessagingService the adapter composes.
//
// THIN-CORE WRAP, NOT THIN PASSTHROUGH (grill D1, os-rewrite #2660/#2666): all DB/state ops
// route through MessagingService — publish→send, subscribe→service.subscribe, replayFrom→
// replayMessages (I3), ack→advanceCursor (I1) — so the NEXT adapter inherits Gaps #1-3 free.
// What CANNOT live in core is the in-process delivery machinery: `onMessage` handlers are JS
// fns (not persistable) and cross-process delivery is POLL-based (CLAUDE.md). So the adapter
// OWNS its hidden delivery module — a per-backplane subscription registry + a `pump()` drain
// loop. `publish` is write-then-return (no subscriber await, #28 never inherited); subscribers
// receive on a `pump()` tick driven by the conformance harness `advance()` (R6 α) in tests and
// the real poller in production.
//
// PROGRESSIVE DESCRIPTOR (architect ruling, os-rewrite #2687): each capability was declared ONLY
// in the slice that implemented it — CORE delivery + topicLifecycle:"explicit" reject + the
// opaque per-channel cursor (I6); durable + reopen() (I7); at-least-once NACK/HOL (I8). The
// descriptor below is now the FINAL 4-axis, every axis proven through the shared conformance suite.

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
import type { MessagingService } from "../../core/messaging/service";
import type { Message as CoreMessage } from "../../core/messaging/types";
import { log } from "../../log";

/**
 * I8 descriptor — the FINAL 4-axis, truthful to the fully-built adapter:
 * - durable:true            → restart-survival proven through the reopen() harness seam (I7).
 * - delivery:"at-least-once" → NACK holds the cursor (head-of-line); the message redelivers on
 *                        the next pump tick (I8). Consumers tolerate duplicates (idempotency theirs).
 * - replayable:true         → replayFrom is backed by MessagingService.replayMessages (I3).
 * - topicLifecycle:"explicit" → publish/subscribe to an unknown channel REJECTS (OD-8); the
 *                        suite provisions CORE topics out-of-band via the harness provision()
 *                        seam (I5.5), the explicit-reject section deliberately does not.
 */
const DESCRIPTOR: CapabilityDescriptor = {
  durable: true,
  replayable: true,
  delivery: "at-least-once",
  topicLifecycle: "explicit",
};

// How many messages a single drain/replay step reads forward at a time. Larger than any
// conformance backlog; the loop keeps reading until the channel is drained, so the value only
// bounds per-step memory, never correctness.
const READ_BATCH = 500;

// =====================================================================================
// Opaque, per-channel cursor codec (F3, spec §2.5/§2.6).
// `messages.id` is a GLOBAL autoincrement PK, so we bind it to the channel name — exactly the
// InMemory pattern — to keep cursors per-channel-scoped. A consumer round-trips a delivered
// Message.cursor back to replayFrom; it NEVER constructs or parses one. A cursor minted for a
// different channel (foreign) or malformed is REJECTED, never coerced by numeric position.
// =====================================================================================
function mintCursor(topic: string, messageId: number): Cursor {
  return asCursor(`${topic.length}:${topic}:${messageId}`);
}

function parseCursor(topic: string, cursor: Cursor): number | null {
  const raw = cursor as string;
  const sep = raw.indexOf(":");
  if (sep < 0) return null;
  const len = Number(raw.slice(0, sep));
  if (!Number.isInteger(len) || len < 0) return null;
  const cursorTopic = raw.slice(sep + 1, sep + 1 + len);
  if (cursorTopic !== topic) return null; // foreign-channel cursor → rejected
  if (raw[sep + 1 + len] !== ":") return null;
  const idStr = raw.slice(sep + 1 + len + 1);
  const id = Number(idStr);
  if (idStr === "" || !Number.isInteger(id)) return null;
  return id;
}

/** Map a core domain Message to the contracts Message delivered over the seam. */
function toMessage(topic: string, m: CoreMessage): Message {
  return {
    topic,
    from: asPeerId(m.agent_id), // publisher identity (OD-1) — round-tripped, never minted by the consumer
    data: m.content,
    cursor: mintCursor(topic, m.id), // the id of THIS message on THIS channel (γ-1)
  };
}

// =====================================================================================
// Adapter-local delivery state (hidden module). Handlers are JS fns, so this lives in-process,
// NOT in core/DB. One backplane per MessagingService instance (one DB connection); peers share
// it; `pump()` drives every active subscription forward from its held cursor.
// =====================================================================================
interface Subscription {
  readonly peer: PeerId;
  readonly agentId: string; // plain id for MessagingService calls
  readonly topic: string;
  onMessage: OnMessage;
  /** Last ACKed global message id; 0 = nothing acked → full backlog (catch-up). */
  cursor: number;
  /** Re-entrancy guard so an overlapping tick does not double-drain one subscription. */
  draining: boolean;
  /**
   * Set when a tick was suppressed by the re-entrancy guard while an outer drain was suspended
   * at `await onMessage`. The outer drain re-checks once more in its do-while, so the suppressed
   * cycle (an overlapping publish/tick) is not stranded across a NACK-break (at-least-once F2).
   */
  pending: boolean;
}

export interface SqliteBackplane {
  readonly svc: MessagingService;
  readonly subscriptions: Subscription[];
  readonly peers: Set<PeerId>;
}

export function createSqliteBackplane(svc: MessagingService): SqliteBackplane {
  return { svc, subscriptions: [], peers: new Set() };
}

/**
 * Drain one subscription forward from its held cursor (delivery:"at-least-once", spec §2.7):
 * read the next message strictly-after the cursor (no self-exclude, no read-side mutation —
 * Gap#3 replayMessages), await the handler, then ACK→advance the persisted cursor (Gap#1
 * advanceCursor) or NACK→HOLD. A throwing handler does NOT advance the cursor (head-of-line: N
 * blocks N+1), so the message reappears on the NEXT pump tick read forward from the unadvanced
 * cursor — redelivery is next-cycle, never a synchronous retry (a poison pill wedges the topic,
 * never tight-loops). Mirrors the InMemory reference drain, incl. the re-entrancy/`pending`
 * guard: a tick suppressed while this drain is suspended re-runs in the do-while so an
 * overlapping publish is not stranded across a NACK-break (F2).
 */
async function drain(bp: SqliteBackplane, sub: Subscription): Promise<void> {
  if (sub.draining) {
    sub.pending = true; // re-check after the in-flight drain finishes (overlap not stranded)
    return;
  }
  sub.draining = true;
  try {
    do {
      sub.pending = false;
      // Read the backlog forward in batches (R3 F5): a cursor-0 catch-up on a large durable
      // backlog must NOT be O(N) single-row queries monopolizing the one-per-process connection.
      // Iterate the batch in memory with per-message ACK/HOL; refetch only when it is exhausted.
      let batch = bp.svc.replayMessages(sub.agentId, sub.topic, sub.cursor, READ_BATCH);
      batchLoop: while (batch.length > 0) {
        for (const next of batch) {
          try {
            await sub.onMessage(toMessage(sub.topic, next));
          } catch (err) {
            // NACK → cursor HOLDS (head-of-line: N blocks N+1, the rest of the batch is NOT
            // consumed); redelivered from this message on the next pump tick. Stop draining.
            log(`sqlite-pubsub NACK ${sub.agentId}@${sub.topic} msg ${next.id}: ${err}`);
            break batchLoop;
          }
          // Persist-then-advance per message: write the durable cursor FIRST, then move the
          // in-memory cursor. If the persist throws it is contained below with BOTH cursors still
          // at the prior id (consistent; redelivers next tick) — never the split state of
          // advancing in-memory first.
          bp.svc.advanceCursor(sub.agentId, sub.topic, next.id); // ACK → persist
          sub.cursor = next.id; // ACK → advance past this message
        }
        // Batch fully ACKed → fetch the next one strictly-after the advanced cursor.
        batch = bp.svc.replayMessages(sub.agentId, sub.topic, sub.cursor, READ_BATCH);
      }
    } while (sub.pending);
  } catch (err) {
    // A storage throw from replayMessages/advanceCursor (SQLITE_BUSY past retries, IOERR, or a
    // connection closed mid-reopen()) is CONTAINED here, not floated as an unhandled rejection.
    // The cursor is unadvanced (persist-then-advance) so the message redelivers on the next pump
    // tick — same outcome as NACK/HOL.
    log(`sqlite-pubsub drain fault ${sub.agentId}@${sub.topic}: ${err}`);
  } finally {
    sub.draining = false;
  }
}

/**
 * One deterministic, TIMER-FREE poll tick: fan a drain out to every active subscription. Like
 * the InMemory reference's publish fan-out (#28), drains are fired INDEPENDENTLY (`void`) — a
 * slow/suspended handler must not wedge the tick or starve co-subscribers. A snapshot guards
 * against (un)subscribe mutating the set mid-tick. drain() contains its own handler NACKs AND the
 * storage throws from replayMessages/advanceCursor (SQLITE_BUSY/IOERR/closed-mid-reopen), so the
 * floated promise normally resolves; the `.catch` is a belt-and-suspenders net that logs any
 * truly-unexpected rejection instead of leaking it. Wired to the harness `advance()` (R6 α) in
 * tests and the real poller in production.
 */
export async function pump(bp: SqliteBackplane): Promise<void> {
  for (const sub of [...bp.subscriptions]) {
    void drain(bp, sub).catch((err) =>
      log(`sqlite-pubsub drain fault ${sub.agentId}@${sub.topic}: ${err}`)
    );
  }
}

/** A PubSub + PeerDiscovery pair bound to one peer identity over a shared backplane. */
export interface Peer {
  readonly id: PeerId;
  readonly pubsub: PubSub;
  readonly discovery: PeerDiscovery;
}

/**
 * Connect a peer: bind its identity (OD-1) and register it on the shared MessagingService. The
 * adapter holds NO database handle — `svc` is the injected core domain service.
 */
export function connectSqlitePeer(bp: SqliteBackplane, name: string): Peer {
  bp.svc.register(name);
  const id = asPeerId(name);
  const agentId = name;
  bp.peers.add(id);

  function find(topic: string): Subscription | undefined {
    return bp.subscriptions.find((s) => s.peer === id && s.topic === topic);
  }

  const pubsub: PubSub = {
    capabilities: DESCRIPTOR,

    async publish(topic, data) {
      // Write-then-return (no subscriber await): delivery happens on a later pump() tick.
      // topicLifecycle:"explicit" — send THROWS on an unknown channel (OD-8); no auto-create.
      bp.svc.send(agentId, topic, data);
    },

    async subscribe(topic, onMessage) {
      const existing = find(topic);
      if (existing) {
        // Re-subscribe to an active topic: replace the handler, cursor unchanged (spec §2.4).
        existing.onMessage = onMessage;
        return;
      }
      // Join membership — service.subscribe THROWS on an unknown channel (explicit). Then
      // resume from the held cursor (0 for a brand-new subscriber → full backlog catch-up).
      bp.svc.subscribe(agentId, topic);
      const cursor = bp.svc.getCursorPosition(agentId, topic);
      bp.subscriptions.push({ peer: id, agentId, topic, onMessage, cursor, draining: false, pending: false });
      // Delivery is deferred to the next pump() tick (poll), NOT synchronous here.
    },

    async unsubscribe(topic) {
      // Stop-only (spec §2.4): drop the in-process handler; the persisted cursor + membership
      // flag are preserved by service.unsubscribe (subscribed=0, last_read_message_id kept), so
      // a later re-subscribe resumes from the held cursor.
      bp.svc.unsubscribe(agentId, topic);
      const idx = bp.subscriptions.findIndex((s) => s.peer === id && s.topic === topic);
      if (idx >= 0) bp.subscriptions.splice(idx, 1);
    },

    async replayFrom(topic, cursor, onMessage) {
      // Opaque per-channel cursor: reject foreign-channel / malformed BEFORE any read (F3,
      // never coerce). Then a stateless forward read STRICTLY AFTER the cursor — no cursor
      // mutation, no self-exclude (Gap#3). Unknown channel → empty (non-creating read).
      const after = parseCursor(topic, cursor);
      if (after === null) {
        throw new Error("cursor is not from this topic on this backend");
      }
      let from = after;
      while (true) {
        const batch = bp.svc.replayMessages(agentId, topic, from, READ_BATCH);
        if (batch.length === 0) break;
        for (const coreMsg of batch) {
          await onMessage(toMessage(topic, coreMsg));
          from = coreMsg.id;
        }
        if (batch.length < READ_BATCH) break;
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
