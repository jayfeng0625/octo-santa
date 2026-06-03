// tests/conformance/poll-seam.test.ts
//
// R6 amendment, Option α (os-rewrite #2662): the conformance harness gains an OPTIONAL
// `advance()` seam — the deterministic, timer-free "poll tick" — and the suite settles via
// ONE uniform primitive, `settle(harness)`. Push impls (InMemory) have no `advance()` and
// fall back to a microtask drain; poll impls (SQLite, I6) define `advance()` to drive their
// `pump()` once. The SUITE BODY is identical across backends — only the per-backend harness
// factory differs.
//
// This is a SEAM-MECHANISM test, NOT a conformance duplicate: it proves `settle()` routes to
// `advance()` for a poll backend and microtask-drains for a push backend, using minimal FAKE
// backends. The real SQLite `pump()` rides this seam in I6.

import { describe, it, expect } from "bun:test";
import type { ConformanceHarness } from "./harness";
import { settle } from "./suite";

describe("R6 α — conformance harness poll seam (settle → advance)", () => {
  it("poll backend: settle() drives advance() so a poll-deferred delivery is observed", async () => {
    // POLL semantics: publish only enqueues; nothing is delivered until a tick (advance()).
    const pending: string[] = [];
    const delivered: string[] = [];
    const pollHarness = {
      // One advance() = one deterministic poll tick: drain the queue. No timers.
      advance: async () => {
        while (pending.length) delivered.push(pending.shift()!);
      },
    } as unknown as ConformanceHarness;

    pending.push("m1", "m2");
    expect(delivered).toEqual([]); // before a tick, a poll backend has delivered nothing

    await settle(pollHarness);
    expect(delivered).toEqual(["m1", "m2"]); // settle() drove advance() → delivered in order
  });

  it("push backend: settle() microtask-drains when advance() is absent", async () => {
    const delivered: string[] = [];
    // PUSH semantics: delivery scheduled on a microtask (as InMemory drains inside publish).
    void Promise.resolve().then(() => delivered.push("pushed"));
    const pushHarness = {} as ConformanceHarness; // no advance()

    await settle(pushHarness);
    expect(delivered).toEqual(["pushed"]); // microtasks drained, no tick required
  });

  it("settle() tolerates an undefined harness (microtask drain only)", async () => {
    const delivered: string[] = [];
    void Promise.resolve().then(() => delivered.push("x"));
    await settle(undefined);
    expect(delivered).toEqual(["x"]);
  });
});
