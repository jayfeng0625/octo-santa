// tests/conformance/suite.ts
//
// Parameterized PubSub conformance suite (NORMATIVE spec 2026-06-02-thin-core-contracts.md
// §4 = Phase A definition-of-done). The suite is the contractual proof a backend "is
// octo-santa": it validates the SAME behaviors against EVERY impl, gating descriptor-
// specific sections off the impl's own `CapabilityDescriptor`. The SQLite factory slots in
// UNCHANGED at Phase B — this file does not change.
//
// SUITE INVARIANT (spec §4): the suite NEVER constructs a `Cursor`/`PeerId` literal. The
// brand makes that a COMPILE error. Every id is round-tripped from a delivered Message
// (`msg.cursor`, `msg.from`) or from `discovery.list()`. If you find yourself casting, you
// are doing it wrong.

import { describe, it, expect, afterEach } from "bun:test";
import type { Message } from "../../src/contracts";
import type { ConformanceHarness, HarnessFactory, Peer } from "./harness";

// Delivery is driven by `publish`/`subscribe` completing. We add a tiny microtask flush so
// impls that defer delivery to microtasks settle before assertions. No timers, no sleeps —
// deterministic.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// A monotonically-incrementing suffix keeps topic names unique ACROSS tests within one
// harness instance, so held cursors / backlogs from a prior test never leak into the next.
// (CORE tests share a harness; per-test isolation comes from per-test topic names.)
let topicSeq = 0;
const freshTopic = (label: string): string => `${label}-${topicSeq++}`;

/**
 * Register the conformance suite for one impl. ASYNC: it probes a peer's `capabilities`
 * (spec §4 — "suite reads pubsub.capabilities to decide") on a throwaway harness, disposes
 * it, then registers CORE + descriptor-gated sections. Call with top-level `await` from a
 * `.test.ts` file.
 */
export async function runConformanceSuite(label: string, factory: HarnessFactory): Promise<void> {
  // --- Probe the descriptor (read from the impl itself, never hard-coded) ---
  const probeHarness = await factory();
  const probePeer = await probeHarness.connect("__probe__");
  const caps = probePeer.pubsub.capabilities;
  await probeHarness.cleanup();

  describe(`PubSub conformance — ${label}`, () => {
    // ===================================================================================
    // CORE — runs for EVERY impl.
    // ===================================================================================
    describe("CORE", () => {
      // Each CORE test gets its OWN fresh backplane instance via newPeers(), so state never
      // leaks between tests. afterEach disposes whatever instance the last test created
      // (Phase B: releases the SQLite temp DB; InMemory: no-op).
      let harness: ConformanceHarness | undefined;

      async function newPeers(...names: string[]): Promise<Peer[]> {
        harness = await factory();
        const peers: Peer[] = [];
        for (const n of names) peers.push(await harness.connect(n));
        return peers;
      }

      afterEach(async () => {
        if (harness) {
          await harness.cleanup();
          harness = undefined;
        }
      });

      it("cross-peer delivery: A.publish → B receives with from === A.id", async () => {
        const [a, b] = await newPeers("alice", "bob");
        const topic = freshTopic("xpeer");
        const got: Message[] = [];
        await b!.pubsub.subscribe(topic, (m) => {
          got.push(m);
        });
        await a!.pubsub.publish(topic, "hello-from-a");
        await flush();
        expect(got.length).toBe(1);
        expect(got[0]!.data).toBe("hello-from-a");
        expect(got[0]!.topic).toBe(topic);
        // round-trip identity assertion — A.id obtained from connect(), never minted.
        expect(got[0]!.from).toBe(a!.id);
      });

      it("per-topic FIFO ordering", async () => {
        const [a] = await newPeers("alice");
        const topic = freshTopic("fifo");
        const got: string[] = [];
        await a!.pubsub.subscribe(topic, (m) => {
          got.push(m.data);
        });
        await a!.pubsub.publish(topic, "1");
        await a!.pubsub.publish(topic, "2");
        await a!.pubsub.publish(topic, "3");
        await flush();
        expect(got).toEqual(["1", "2", "3"]);
      });

      it("race-free delivery: subscribe then publish fires, in FIFO order", async () => {
        const [a] = await newPeers("alice");
        const topic = freshTopic("race");
        const got: string[] = [];
        await a!.pubsub.subscribe(topic, (m) => {
          got.push(m.data);
        });
        await a!.pubsub.publish(topic, "first");
        await a!.pubsub.publish(topic, "second");
        await flush();
        expect(got).toEqual(["first", "second"]);
      });

      it("catch-up from cursor 0: a new subscriber receives the full backlog in order, then live", async () => {
        const [a, b] = await newPeers("alice", "bob");
        const topic = freshTopic("catchup");
        await a!.pubsub.publish(topic, "1");
        await a!.pubsub.publish(topic, "2");
        const got: string[] = [];
        await b!.pubsub.subscribe(topic, (m) => {
          got.push(m.data);
        });
        await flush();
        expect(got).toEqual(["1", "2"]); // full backlog from 0
        await a!.pubsub.publish(topic, "3");
        await flush();
        expect(got).toEqual(["1", "2", "3"]); // then live
      });

      it("replayFrom exclusivity: strictly-after cursor, does NOT advance the subscription cursor", async () => {
        const [a] = await newPeers("alice");
        const topic = freshTopic("replay");
        const live: Message[] = [];
        await a!.pubsub.subscribe(topic, (m) => {
          live.push(m);
        });
        await a!.pubsub.publish(topic, "1");
        await a!.pubsub.publish(topic, "2");
        await a!.pubsub.publish(topic, "3");
        await flush();
        expect(live.map((m) => m.data)).toEqual(["1", "2", "3"]);

        // cursor of message "1" — round-tripped from the delivered Message, never minted.
        const cursorOf1 = live[0]!.cursor;
        const replayed: string[] = [];
        await a!.pubsub.replayFrom(topic, cursorOf1, (m) => {
          replayed.push(m.data);
        });
        await flush();
        // strictly AFTER "1" → "2","3" (cursor message itself excluded).
        expect(replayed).toEqual(["2", "3"]);

        // replay did NOT mutate subscription state → next live publish delivered exactly once.
        await a!.pubsub.publish(topic, "4");
        await flush();
        expect(live.map((m) => m.data)).toEqual(["1", "2", "3", "4"]);
      });

      it("peer list: list() returns the connected peers (>= 2 via connect)", async () => {
        const [a, b] = await newPeers("alice", "bob");
        const peers = await a!.discovery.list();
        // round-trip: compare against ids obtained from connect(), never literals.
        expect([...peers].sort()).toEqual([a!.id, b!.id].sort());
        // b sees the same backplane.
        const fromB = await b!.discovery.list();
        expect([...fromB].sort()).toEqual([a!.id, b!.id].sort());
      });

      it("unsubscribe stop-only: re-subscribe resumes from the held cursor, not 0", async () => {
        const [a] = await newPeers("alice");
        const topic = freshTopic("unsub");
        const got: string[] = [];
        await a!.pubsub.subscribe(topic, (m) => {
          got.push(m.data);
        });
        await a!.pubsub.publish(topic, "1");
        await flush();
        expect(got).toEqual(["1"]);

        await a!.pubsub.unsubscribe(topic);
        // published while unsubscribed — not delivered now.
        await a!.pubsub.publish(topic, "2");
        await flush();
        expect(got).toEqual(["1"]);

        // re-subscribe resumes from held cursor (after "1"), NOT replay from 0.
        await a!.pubsub.subscribe(topic, (m) => {
          got.push(m.data);
        });
        await flush();
        expect(got).toEqual(["1", "2"]); // only the missed "2", never "1" again
      });
    });

    // ===================================================================================
    // DESCRIPTOR-GATED — topicLifecycle (MUTUALLY EXCLUSIVE pair).
    // The suite reads caps.topicLifecycle; exactly one branch runs, the other is SKIPPED.
    // Both branches are AUTHORED so the suite is literally unchanged in Phase B (explicit
    // is dormant in Phase A — no impl selects it yet, but it is written + selectable).
    // ===================================================================================
    describe.skipIf(caps.topicLifecycle !== "implicit")(
      'topicLifecycle "implicit" — unknown-topic auto-create symmetry',
      () => {
        it("subscribe to an unknown topic auto-creates it (empty, no error)", async () => {
          const harness = await factory();
          try {
            const a = await harness.connect("alice");
            const topic = freshTopic("implicit-sub");
            const got: Message[] = [];
            await a.pubsub.subscribe(topic, (m) => {
              got.push(m);
            });
            await flush();
            expect(got.length).toBe(0); // empty, never an error
            await a.pubsub.publish(topic, "live");
            await flush();
            expect(got.map((m) => m.data)).toEqual(["live"]);
          } finally {
            await harness.cleanup();
          }
        });

        it("publish to an unknown topic auto-creates it (never an error)", async () => {
          const harness = await factory();
          try {
            const a = await harness.connect("alice");
            const topic = freshTopic("implicit-pub");
            await a.pubsub.publish(topic, "x"); // must not throw
            const got: Message[] = [];
            await a.pubsub.subscribe(topic, (m) => {
              got.push(m);
            });
            await flush();
            expect(got.map((m) => m.data)).toEqual(["x"]); // backlog from auto-created topic
          } finally {
            await harness.cleanup();
          }
        });
      }
    );

    describe.skipIf(caps.topicLifecycle !== "explicit")(
      'topicLifecycle "explicit" — unknown-topic rejection',
      () => {
        // Dormant in Phase A: no impl declares "explicit". Authored + selectable so the
        // suite is literally unchanged when SQLite (explicit, OD-8: publish→send THROWS on
        // unknown channel) runs it in Phase B.
        it("publish to an uncreated topic REJECTS", async () => {
          const harness = await factory();
          try {
            const a = await harness.connect("alice");
            const topic = freshTopic("explicit-pub");
            await expect(a.pubsub.publish(topic, "x")).rejects.toThrow();
          } finally {
            await harness.cleanup();
          }
        });

        it("subscribe to an uncreated topic REJECTS", async () => {
          const harness = await factory();
          try {
            const a = await harness.connect("alice");
            const topic = freshTopic("explicit-sub");
            await expect(
              a.pubsub.subscribe(topic, () => {})
            ).rejects.toThrow();
          } finally {
            await harness.cleanup();
          }
        });
      }
    );

    // ===================================================================================
    // DESCRIPTOR-GATED — delivery "at-least-once" (ack/nack, next-cycle, HOL, poison-pill).
    // Redelivery is triggered DETERMINISTICALLY by a subsequent publish — NO sleeps/timers.
    // ===================================================================================
    describe.skipIf(caps.delivery !== "at-least-once")(
      'delivery "at-least-once" — NACK redelivery, HOL, duplicate tolerance',
      () => {
        it("NACK holds the cursor; message is redelivered on the NEXT cycle (subsequent publish)", async () => {
          const harness = await factory();
          try {
            const a = await harness.connect("alice");
            const topic = freshTopic("alo-nack");
            const attempts: string[] = [];
            let failFirst = true;
            await a.pubsub.subscribe(topic, (m) => {
              attempts.push(m.data);
              if (m.data === "n" && failFirst) {
                failFirst = false;
                throw new Error("NACK n");
              }
            });
            await a.pubsub.publish(topic, "n");
            await flush();
            // delivered once and NACKed; NOT synchronously retried (no tight loop).
            expect(attempts).toEqual(["n"]);
            // next cycle (a subsequent publish) re-reads forward from the held cursor.
            await a.pubsub.publish(topic, "next");
            await flush();
            // "n" redelivered (ACKed this time), then "next".
            expect(attempts).toEqual(["n", "n", "next"]);
          } finally {
            await harness.cleanup();
          }
        });

        it("head-of-line: a NACKed N blocks N+1 until N ACKs", async () => {
          const harness = await factory();
          try {
            const a = await harness.connect("alice");
            const topic = freshTopic("alo-hol");
            const attempts: string[] = [];
            let nFails = true;
            await a.pubsub.subscribe(topic, (m) => {
              attempts.push(m.data);
              if (m.data === "N" && nFails) {
                throw new Error("hold N");
              }
            });
            await a.pubsub.publish(topic, "N");
            await flush();
            expect(attempts).toEqual(["N"]); // N delivered + NACKed; cursor holds

            // Publishing N+1 is itself a next cycle: N is redelivered (NACK again), and HOL
            // blocks N+1 — it must NOT appear while N is unacked.
            await a.pubsub.publish(topic, "N+1");
            await flush();
            expect(attempts).toEqual(["N", "N"]);

            // Let N succeed, trigger the next cycle.
            nFails = false;
            await a.pubsub.publish(topic, "N+2");
            await flush();
            // This cycle redelivers N (now ACKs), then N+1, then N+2 — all in order.
            expect(attempts).toEqual(["N", "N", "N", "N+1", "N+2"]);
          } finally {
            await harness.cleanup();
          }
        });

        it("duplicate tolerance: a redelivered message is observed more than once (idempotency is the consumer's job)", async () => {
          const harness = await factory();
          try {
            const a = await harness.connect("alice");
            const topic = freshTopic("alo-dup");
            const seen: string[] = [];
            let failOnce = true;
            await a.pubsub.subscribe(topic, (m) => {
              seen.push(m.data);
              if (m.data === "d" && failOnce) {
                failOnce = false;
                throw new Error("NACK once");
              }
            });
            await a.pubsub.publish(topic, "d");
            await flush();
            await a.pubsub.publish(topic, "trigger");
            await flush();
            // "d" appears TWICE — at-least-once delivers duplicates; the consumer must dedupe.
            expect(seen.filter((x) => x === "d").length).toBe(2);
          } finally {
            await harness.cleanup();
          }
        });

        it("poison-pill HOL: an always-throwing handler wedges the topic at N (KNOWN Phase-A limitation, asserted as intended)", async () => {
          const harness = await factory();
          try {
            const a = await harness.connect("alice");
            const topic = freshTopic("alo-poison");
            const attempts: string[] = [];
            await a.pubsub.subscribe(topic, (m) => {
              attempts.push(m.data);
              if (m.data === "poison") {
                throw new Error("always throws"); // never ACKs
              }
            });
            await a.pubsub.publish(topic, "poison");
            await flush();
            // Drive several cycles; the poison message keeps being redelivered and the
            // cursor never advances → nothing past it is ever delivered.
            await a.pubsub.publish(topic, "after-1");
            await flush();
            await a.pubsub.publish(topic, "after-2");
            await flush();
            // ONLY "poison" was ever attempted (redelivered each cycle); "after-*" wedged.
            expect(new Set(attempts)).toEqual(new Set(["poison"]));
            expect(attempts.includes("after-1")).toBe(false);
            expect(attempts.includes("after-2")).toBe(false);
          } finally {
            await harness.cleanup();
          }
        });
      }
    );

    // ===================================================================================
    // DESCRIPTOR-GATED — durable (cross-process / restart replay).
    // SKIPPED for InMemory (durable:false) — reported skipped, NOT failed. SQLite proves it
    // in Phase B. Authored now so the suite is literally unchanged.
    // ===================================================================================
    describe.skipIf(!caps.durable)("durable — cross-process / restart replay", () => {
      it("messages survive a backplane restart and replay forward", async () => {
        // A durable impl persists to a backing store that outlives a restart. We write via
        // one harness, REOPEN the SAME store (simulated restart via the harness.reopen()
        // seam), and assert a FRESH peer on the reopened store still sees the message. This
        // is a REAL restart-survival proof — not a stub. InMemory is durable:false → this
        // block is SKIPPED and reopen() is never called; SQLite (durable:true) implements
        // reopen() and runs this body UNCHANGED in Phase B.
        const harness = await factory();
        let reopened: ConformanceHarness | undefined;
        try {
          const a = await harness.connect("alice");
          const topic = freshTopic("durable");
          await a.pubsub.publish(topic, "persisted");

          // A durable impl MUST expose the restart seam; without it the test FAILS LOUDLY
          // (no false pass). This is exactly the seam Phase B fills — defined now so the
          // test body and harness shape are unchanged later.
          if (!harness.reopen) {
            throw new Error(
              "durable impl must implement ConformanceHarness.reopen() to prove restart-survival"
            );
          }
          reopened = await harness.reopen();

          // Fresh peer on the REOPENED store catches up from the persisted backlog.
          const b = await reopened.connect("bob");
          const got: string[] = [];
          await b.pubsub.subscribe(topic, (m) => {
            got.push(m.data);
          });
          await flush();
          expect(got).toEqual(["persisted"]); // survived the restart
        } finally {
          await harness.cleanup();
          if (reopened) await reopened.cleanup();
        }
      });
    });
  });
}
