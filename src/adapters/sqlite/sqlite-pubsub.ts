// src/adapters/sqlite/sqlite-pubsub.ts
//
// SQLite adapter behind the thin-core seam (NORMATIVE spec 2026-06-02-thin-core-contracts.md
// §2, §3, §4). The DURABLE, cross-process backend: octo-santa's messaging IS this adapter
// over the shared SQLite db.
//
// BOUNDARY (CLAUDE.md + archunit hexagonal-boundaries.test.ts): this adapter wraps the CORE
// domain service (MessagingService) and the src/contracts seam ONLY. It NEVER imports
// `src/storage` or `bun:sqlite` (adapters ↛ storage). Concrete SQLite repos are injected at
// the composition root / conformance harness, into the MessagingService the adapter composes.
//
// PROGRESSIVE DESCRIPTOR (architect ruling, os-rewrite #2687): declare each capability ONLY
// in the slice that implements it, so the suite's skipIf(caps…) green-skips an axis until its
// slice flips it on — no descriptor lies. This skeleton (I4) wires the surface + descriptor +
// boundary; CORE delivery (publish/subscribe/replayFrom via pump()) lands in I6, durable +
// reopen() in I7, at-least-once NACK/HOL in I8. Final 4-axis descriptor is reached at I8.

import {
  asPeerId,
  type PeerId,
  type PubSub,
  type PeerDiscovery,
  type CapabilityDescriptor,
} from "../../contracts";
import type { MessagingService } from "../../core/messaging/service";

/**
 * I4 descriptor — truthful to what is built so far:
 * - durable:false      → flips true in I7 (reopen() restart-survival seam)
 * - delivery:"at-most-once" → flips "at-least-once" in I8 (NACK/HOL poll redelivery)
 * - replayable:true    → replayFrom is backed by MessagingService.replayMessages (I3); the
 *                        suite has no replayable-gated section, so this is declarative.
 * - topicLifecycle:"explicit" → SQLite never auto-creates; publish/subscribe to an unknown
 *                        channel REJECTS (enforced in I6). The explicit-gated section runs
 *                        only once the pre-CORE gate is removed in I6.
 */
const DESCRIPTOR: CapabilityDescriptor = {
  durable: false,
  replayable: true,
  delivery: "at-most-once",
  topicLifecycle: "explicit",
};

const DELIVERY_TODO =
  "SQLite PubSub delivery lands in I6 (CORE publish/subscribe/replayFrom via the pump() seam)";

/** A PubSub + PeerDiscovery pair bound to one peer identity over a MessagingService. */
export interface Peer {
  readonly id: PeerId;
  readonly pubsub: PubSub;
  readonly discovery: PeerDiscovery;
}

/**
 * Connect a peer: bind its identity (OD-1) and register it on the shared MessagingService.
 * Delivery is stubbed at this slice (I4) — the descriptor, the surface, and the
 * adapter→core boundary are real. `svc` is the injected core domain service; the adapter
 * holds NO database handle of its own.
 */
export function connectSqlitePeer(svc: MessagingService, name: string): Peer {
  // Bind/register the peer identity on the core service (the adapter never touches storage).
  svc.register(name);
  const id = asPeerId(name);

  const pubsub: PubSub = {
    capabilities: DESCRIPTOR,
    async publish() {
      throw new Error(DELIVERY_TODO);
    },
    async subscribe() {
      throw new Error(DELIVERY_TODO);
    },
    async unsubscribe() {
      throw new Error(DELIVERY_TODO);
    },
    async replayFrom() {
      throw new Error(DELIVERY_TODO);
    },
  };

  const discovery: PeerDiscovery = {
    async list(): Promise<readonly PeerId[]> {
      throw new Error(DELIVERY_TODO);
    },
  };

  return { id, pubsub, discovery };
}
