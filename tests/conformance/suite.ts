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
//
// SCOPE — DELIVERY TIMING via the UNIFORM HARNESS PRIMITIVE `settle(harness)` (R6 amendment,
// Option α — os-rewrite #2662, ratified #2662). The suite body settles at every assertion
// point through ONE call, `settle(harness)`; what a settlement MEANS is defined by the
// per-backend harness, NOT the suite. Push impls (the InMemory reference, which drains every
// subscriber synchronously inside `publish`) leave `harness.advance` undefined → `settle`
// microtask-drains. Poll impls (the Phase B SQLite adapter, a future Cloudflare adapter)
// deliver on a `pump()` tick (CLAUDE.md: "cross-process delivery requires polling"; spec §2.7:
// redelivery is "next publish (push) OR next poll tick (poll)") → their harness defines
// `advance()` as a single deterministic, TIMER-FREE `pump()` drive, and `settle` ticks it.
// So the SUITE BODY is byte-for-byte identical across backends — only the harness factory
// differs, exactly as `reopen()` isolates the durable axis. β (until/timeout) is NOT adopted:
// a deterministic tick keeps the no-sleeps/no-timers invariant, so no flake enters. The
// at-least-once section still triggers a "next cycle" by a subsequent publish; for a poll
// backend each interleaved `settle` is the tick that drives redelivery (re-parameterized in
// the harness, assertions unchanged). The descriptor stays locked to 4 axes (spec §1 D).

import { describe, it, expect, afterEach } from "bun:test";
import type { Message } from "../../src/contracts";
import type { ConformanceHarness, HarnessFactory, Peer } from "./harness";

// The UNIFORM settlement primitive (R6 α). ONE call the suite body uses everywhere; the
// per-backend harness decides what it means: a poll impl's `advance()` drives a deterministic
// `pump()` tick, then we microtask-drain; a push impl has no `advance()` and only the
// microtask drain runs. No timers, no sleeps — deterministic for every backend. Exported so
// the seam itself is unit-tested (tests/conformance/poll-seam.test.ts).
export async function settle(harness?: ConformanceHarness): Promise<void> {
  if (harness?.advance) await harness.advance();
  await Promise.resolve();
  await Promise.resolve();
}

// Out-of-band topic provisioning (architect ruling os-rewrite #2707, ratified #2721/#2722).
// The PubSub seam has NO create-topic op — topic creation is octo-santa's CONTROL plane
// (createChannel / messaging_create_channel), separate from the publish/subscribe DATA plane
// (spec §2.2). So an `topicLifecycle:"explicit"` backend (SQLite: publish/subscribe to an
// unknown topic REJECTS) needs topics created out-of-band before a DELIVERY test can exercise
// them. ensureTopic is that uniform hook: the per-backend harness defines `provision?(topic)`
// (SQLite → createChannel); push/implicit impls (InMemory, auto-create) leave it undefined →
// no-op. Called by the DELIVERY-proving sections (CORE, at-least-once, durable) after
// freshTopic(), before first pub/sub. The LIFECYCLE-reject sections (implicit auto-create /
// explicit reject) deliberately DO NOT call it — un-provisioned behavior is what they prove.
// No per-impl branch in the suite body. Exported so the seam is unit-tested
// (tests/conformance/provision-seam.test.ts).
export async function ensureTopic(
  harness: ConformanceHarness | undefined,
  topic: string
): Promise<void> {
  if (harness?.provision) await harness.provision(topic);
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
        await ensureTopic(harness, topic);
        const got: Message[] = [];
        await b!.pubsub.subscribe(topic, (m) => {
          got.push(m);
        });
        await a!.pubsub.publish(topic, "hello-from-a");
        await settle(harness);
        expect(got.length).toBe(1);
        expect(got[0]!.data).toBe("hello-from-a");
        expect(got[0]!.topic).toBe(topic);
        // round-trip identity assertion — A.id obtained from connect(), never minted.
        expect(got[0]!.from).toBe(a!.id);
      });

      it("per-topic FIFO ordering", async () => {
        const [a] = await newPeers("alice");
        const topic = freshTopic("fifo");
        await ensureTopic(harness, topic);
        const got: string[] = [];
        await a!.pubsub.subscribe(topic, (m) => {
          got.push(m.data);
        });
        await a!.pubsub.publish(topic, "1");
        await a!.pubsub.publish(topic, "2");
        await a!.pubsub.publish(topic, "3");
        await settle(harness);
        expect(got).toEqual(["1", "2", "3"]);
      });

      it("race-free delivery: subscribe then publish fires, in FIFO order", async () => {
        const [a] = await newPeers("alice");
        const topic = freshTopic("race");
        await ensureTopic(harness, topic);
        const got: string[] = [];
        await a!.pubsub.subscribe(topic, (m) => {
          got.push(m.data);
        });
        await a!.pubsub.publish(topic, "first");
        await a!.pubsub.publish(topic, "second");
        await settle(harness);
        expect(got).toEqual(["first", "second"]);
      });

      it("catch-up from cursor 0: a new subscriber receives the full backlog in order, then live", async () => {
        const [a, b] = await newPeers("alice", "bob");
        const topic = freshTopic("catchup");
        await ensureTopic(harness, topic);
        await a!.pubsub.publish(topic, "1");
        await a!.pubsub.publish(topic, "2");
        const got: string[] = [];
        await b!.pubsub.subscribe(topic, (m) => {
          got.push(m.data);
        });
        await settle(harness);
        expect(got).toEqual(["1", "2"]); // full backlog from 0
        await a!.pubsub.publish(topic, "3");
        await settle(harness);
        expect(got).toEqual(["1", "2", "3"]); // then live
      });

      it("replayFrom exclusivity: strictly-after cursor, does NOT advance the subscription cursor", async () => {
        const [a] = await newPeers("alice");
        const topic = freshTopic("replay");
        await ensureTopic(harness, topic);
        const live: Message[] = [];
        await a!.pubsub.subscribe(topic, (m) => {
          live.push(m);
        });
        await a!.pubsub.publish(topic, "1");
        await a!.pubsub.publish(topic, "2");
        await a!.pubsub.publish(topic, "3");
        await settle(harness);
        expect(live.map((m) => m.data)).toEqual(["1", "2", "3"]);

        // cursor of message "1" — round-tripped from the delivered Message, never minted.
        const cursorOf1 = live[0]!.cursor;
        const replayed: string[] = [];
        await a!.pubsub.replayFrom(topic, cursorOf1, (m) => {
          replayed.push(m.data);
        });
        await settle(harness);
        // strictly AFTER "1" → "2","3" (cursor message itself excluded).
        expect(replayed).toEqual(["2", "3"]);

        // replay did NOT mutate subscription state → next live publish delivered exactly once.
        await a!.pubsub.publish(topic, "4");
        await settle(harness);
        expect(live.map((m) => m.data)).toEqual(["1", "2", "3", "4"]);
      });

      it("replayFrom rejects a foreign-topic cursor and returns empty for an end-of-log cursor (cursors are per-topic-scoped, opaque)", async () => {
        const [a] = await newPeers("alice");
        const topicX = freshTopic("xcursor-x");
        const topicY = freshTopic("xcursor-y");
        await ensureTopic(harness, topicX);
        await ensureTopic(harness, topicY);
        const xMsgs: Message[] = [];
        const yMsgs: Message[] = [];
        await a!.pubsub.subscribe(topicX, (m) => {
          xMsgs.push(m);
        });
        await a!.pubsub.subscribe(topicY, (m) => {
          yMsgs.push(m);
        });
        await a!.pubsub.publish(topicX, "x1");
        await a!.pubsub.publish(topicX, "x2");
        await a!.pubsub.publish(topicY, "y1");
        await settle(harness);

        // FOREIGN-TOPIC: a cursor round-tripped from topic X handed to replayFrom(topicY)
        // is rejected — never silently mapped by numeric position into Y's slice.
        const cursorFromX = xMsgs[0]!.cursor; // never minted — round-tripped from a delivery
        await expect(
          a!.pubsub.replayFrom(topicY, cursorFromX, () => {})
        ).rejects.toThrow();

        // END-OF-LOG (in-range, same-topic): a cursor for the last message on Y yields an
        // empty read — nothing is strictly after it.
        const lastCursorY = yMsgs[yMsgs.length - 1]!.cursor;
        const replayed: string[] = [];
        await a!.pubsub.replayFrom(topicY, lastCursorY, (m) => {
          replayed.push(m.data);
        });
        await settle(harness);
        expect(replayed).toEqual([]);
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
        await ensureTopic(harness, topic);
        const got: string[] = [];
        await a!.pubsub.subscribe(topic, (m) => {
          got.push(m.data);
        });
        await a!.pubsub.publish(topic, "1");
        await settle(harness);
        expect(got).toEqual(["1"]);

        await a!.pubsub.unsubscribe(topic);
        // published while unsubscribed — not delivered now.
        await a!.pubsub.publish(topic, "2");
        await settle(harness);
        expect(got).toEqual(["1"]);

        // re-subscribe resumes from held cursor (after "1"), NOT replay from 0.
        await a!.pubsub.subscribe(topic, (m) => {
          got.push(m.data);
        });
        await settle(harness);
        expect(got).toEqual(["1", "2"]); // only the missed "2", never "1" again
      });

      it("in-flight unsubscribe: a drain suspended at the handler does not deliver/advance past the unsubscribe", async () => {
        const [a] = await newPeers("alice");
        const topic = freshTopic("inflight-unsub");
        await ensureTopic(harness, topic);

        // A gate lets the test suspend the handler INSIDE the drain (the handler runs
        // synchronously up to `await gate` when the drain fires, so `entered` resolves
        // deterministically — no timer, no race).
        let entered!: () => void;
        const enteredP = new Promise<void>((r) => (entered = r));
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));

        const got: string[] = [];
        let first = true;
        await a!.pubsub.subscribe(topic, async (m) => {
          if (first) {
            first = false;
            got.push(m.data);
            entered();
            await gate; // suspend the in-flight drain here
            return;
          }
          got.push(m.data);
        });

        await a!.pubsub.publish(topic, "1");
        await a!.pubsub.publish(topic, "2");

        // Drive a tick: the drain delivers "1" and suspends on the gate (now in-flight).
        const driving = settle(harness);
        await enteredP;

        // Unsubscribe lands WHILE the drain is suspended.
        await a!.pubsub.unsubscribe(topic);

        // Resume: the drain must NOT advance the held cursor past "1" nor deliver "2" to the
        // now-detached subscription.
        release();
        await driving;
        for (let i = 0; i < 4; i++) await settle(harness);
        expect(got).toEqual(["1"]); // "2" never delivered to the detached subscription

        // Held cursor intact (no advance past "1") → re-subscribe redelivers BOTH "1" and "2".
        const got2: string[] = [];
        await a!.pubsub.subscribe(topic, (m) => {
          got2.push(m.data);
        });
        for (let i = 0; i < 4; i++) await settle(harness);
        expect(got2).toEqual(["1", "2"]);
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
            await settle(harness);
            expect(got.length).toBe(0); // empty, never an error
            await a.pubsub.publish(topic, "live");
            await settle(harness);
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
            await settle(harness);
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
    // PUSH-IMPL-SPECIFIC trigger (see SCOPE note at top): for a poll backend the next cycle
    // is a poll TICK, not a subsequent publish, so this trigger is re-parameterized to a
    // harness tick in Phase B — the assertions (redelivery, HOL, duplicate-tolerance) stay.
    // ===================================================================================
    describe.skipIf(caps.delivery !== "at-least-once")(
      'delivery "at-least-once" — NACK redelivery, HOL, duplicate tolerance',
      () => {
        it("NACK holds the cursor; message is redelivered on the NEXT cycle (subsequent publish)", async () => {
          const harness = await factory();
          try {
            const a = await harness.connect("alice");
            const topic = freshTopic("alo-nack");
            await ensureTopic(harness, topic);
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
            await settle(harness);
            // delivered once and NACKed; NOT synchronously retried (no tight loop).
            expect(attempts).toEqual(["n"]);
            // next cycle (a subsequent publish) re-reads forward from the held cursor.
            await a.pubsub.publish(topic, "next");
            await settle(harness);
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
            await ensureTopic(harness, topic);
            const attempts: string[] = [];
            let nFails = true;
            await a.pubsub.subscribe(topic, (m) => {
              attempts.push(m.data);
              if (m.data === "N" && nFails) {
                throw new Error("hold N");
              }
            });
            await a.pubsub.publish(topic, "N");
            await settle(harness);
            expect(attempts).toEqual(["N"]); // N delivered + NACKed; cursor holds

            // Publishing N+1 is itself a next cycle: N is redelivered (NACK again), and HOL
            // blocks N+1 — it must NOT appear while N is unacked.
            await a.pubsub.publish(topic, "N+1");
            await settle(harness);
            expect(attempts).toEqual(["N", "N"]);

            // Let N succeed, trigger the next cycle.
            nFails = false;
            await a.pubsub.publish(topic, "N+2");
            await settle(harness);
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
            await ensureTopic(harness, topic);
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
            await settle(harness);
            await a.pubsub.publish(topic, "trigger");
            await settle(harness);
            // "d" appears TWICE — at-least-once delivers duplicates; the consumer must dedupe.
            expect(seen.filter((x) => x === "d").length).toBe(2);
          } finally {
            await harness.cleanup();
          }
        });

        it("async NACK with an overlapping publish: the next message is not stranded and the NACKed one is redelivered", async () => {
          const harness = await factory();
          try {
            const a = await harness.connect("alice");
            const topic = freshTopic("alo-overlap");
            await ensureTopic(harness, topic);
            const seen: string[] = [];
            let release!: () => void;
            const gate = new Promise<void>((r) => {
              release = r;
            });
            let failN = true;
            await a.pubsub.subscribe(topic, async (m) => {
              seen.push(m.data);
              if (m.data === "N") {
                // Suspend mid-delivery so an overlapping publish lands while we await,
                // then NACK once (spec §2.9 blesses awaiting onMessage as flow control).
                await gate;
                if (failN) {
                  failN = false;
                  throw new Error("NACK N");
                }
              }
            });
            // Publish N — drain suspends at the gate inside onMessage(N).
            const publishN = a.pubsub.publish(topic, "N");
            await settle(harness);
            // Overlapping publish of M while N's handler is suspended. Must not be swallowed.
            const publishM = a.pubsub.publish(topic, "M");
            await settle(harness);
            release(); // N's handler resumes and NACKs.
            await publishN;
            await publishM;
            await settle(harness);
            // At-least-once: N must be redelivered (and ACK this time) and M must be
            // delivered — neither stranded. N appears twice (NACK then ACK), M once.
            expect(seen.filter((x) => x === "N").length).toBe(2);
            expect(seen).toContain("M");
            // FIFO: M is delivered only after N finally ACKs (HOL).
            expect(seen.indexOf("M")).toBe(seen.lastIndexOf("N") + 1);
          } finally {
            await harness.cleanup();
          }
        });

        it("poison-pill HOL: an always-throwing handler wedges the topic at N (KNOWN Phase-A limitation, asserted as intended)", async () => {
          const harness = await factory();
          try {
            const a = await harness.connect("alice");
            const topic = freshTopic("alo-poison");
            await ensureTopic(harness, topic);
            const attempts: string[] = [];
            await a.pubsub.subscribe(topic, (m) => {
              attempts.push(m.data);
              if (m.data === "poison") {
                throw new Error("always throws"); // never ACKs
              }
            });
            await a.pubsub.publish(topic, "poison");
            await settle(harness);
            // Drive several cycles; the poison message keeps being redelivered and the
            // cursor never advances → nothing past it is ever delivered.
            await a.pubsub.publish(topic, "after-1");
            await settle(harness);
            await a.pubsub.publish(topic, "after-2");
            await settle(harness);
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
          await ensureTopic(harness, topic);
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
          await settle(harness);
          expect(got).toEqual(["persisted"]); // survived the restart
        } finally {
          await harness.cleanup();
          if (reopened) await reopened.cleanup();
        }
      });
    });
  });
}
