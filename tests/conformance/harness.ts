// tests/conformance/harness.ts
//
// Conformance harness types (NORMATIVE spec 2026-06-02-thin-core-contracts.md §4,
// architect amendment R6 msg 2571). These live in the conformance TEST-SUPPORT module,
// NOT in src/contracts/index.ts — they exist only to drive the parameterized suite.
//
// Why a harness (not `{ pubsub, cleanup }`): the CORE suite must validate CROSS-PEER
// delivery (peer A publishes → a DIFFERENT peer B on the SAME backplane receives) and
// the "peer list" test (needs >= 2 peers). A single returned `pubsub` yields one identity
// and can only test single-peer loopback. The harness mints N peers on one backplane;
// `cleanup` disposes it.
//
// Each `factory()` call yields a FRESH backplane INSTANCE (hermetic — NOT a process-global
// singleton), so parallel `bun test` files cannot cross-contaminate. InMemory = a registry
// object; SQLite Phase B = a per-invocation temp DB. The suite slots in UNCHANGED at Phase B.

import type { PeerId, PubSub, PeerDiscovery } from "../../src/contracts";

/**
 * A connected peer on a backplane instance. `id` is branded — the adapter mints it from
 * the plain `connect(name)` string at the registration boundary, so the suite NEVER
 * constructs a branded literal (spec §4, B). `.id` is used for round-trip assertions
 * (e.g. `msg.from === A.id`).
 */
export interface Peer {
  readonly id: PeerId;
  readonly pubsub: PubSub;
  readonly discovery: PeerDiscovery;
}

/**
 * Mints peers on ONE backplane instance. `connect(name)` takes a PLAIN string; the adapter
 * brands the `PeerId` internally. `cleanup()` disposes THIS backplane instance.
 */
export interface ConformanceHarness {
  connect(name: string): Promise<Peer>;
  cleanup(): Promise<void>;
  /**
   * Restart seam for DURABLE impls (spec §4 durable axis). Returns a NEW harness over the
   * SAME backing store — a simulated process restart: peers reconnect, persisted messages
   * survive. Durable impls (SQLite, Phase B) implement it; ephemeral impls (InMemory,
   * `durable:false`) leave it undefined — the durable-gated suite section is SKIPPED for
   * them, so `reopen()` is never called. Optional so the harness SHAPE is unchanged in
   * Phase B: the durable test body already uses this seam; filling it in needs no interface
   * edit, keeping "one unchanged suite proves every axis, including durable" true.
   */
  reopen?(): Promise<ConformanceHarness>;
}

/** Each call yields a FRESH hermetic backplane instance (spec §4). */
export type HarnessFactory = () => Promise<ConformanceHarness>;
