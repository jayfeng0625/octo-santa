// tests/conformance/provision-seam.test.ts
//
// Out-of-band topic provisioning seam (architect ruling os-rewrite #2707, ratified #2721/
// #2722): the ConformanceHarness gains an OPTIONAL `provision(topic)` — the out-of-band
// create-topic hook — and the DELIVERY sections provision via ONE uniform primitive,
// `ensureTopic(harness, topic)`. Explicit impls (SQLite, I6) define `provision()` to
// createChannel out-of-band; implicit impls (InMemory, auto-create) leave it undefined and
// `ensureTopic` is a no-op. The suite body is identical across backends — only the per-backend
// harness factory differs (same capability-gated class as reopen()/advance()).
//
// This is a SEAM-MECHANISM test, NOT a conformance duplicate: it proves `ensureTopic()` routes
// to `provision()` for an explicit backend and no-ops for an implicit/push backend, using
// minimal FAKE harnesses. The real SQLite createChannel wiring rides this seam in I6.

import { describe, it, expect } from "bun:test";
import type { ConformanceHarness } from "./harness";
import { ensureTopic } from "./suite";

describe("provision seam — ensureTopic → provision", () => {
  it("explicit backend: ensureTopic() drives provision() with the topic", async () => {
    const provisioned: string[] = [];
    const explicitHarness = {
      // One provision() = create the topic out-of-band (SQLite → createChannel). No data plane.
      provision: async (topic: string) => {
        provisioned.push(topic);
      },
    } as unknown as ConformanceHarness;

    await ensureTopic(explicitHarness, "alpha");
    await ensureTopic(explicitHarness, "beta");
    expect(provisioned).toEqual(["alpha", "beta"]); // ensureTopic routed each topic to provision()
  });

  it("implicit/push backend: ensureTopic() is a no-op when provision() is absent", async () => {
    // InMemory auto-creates on first publish/subscribe → no provision() defined → must not throw.
    const implicitHarness = {} as ConformanceHarness; // no provision()
    await ensureTopic(implicitHarness, "gamma");
    // No observable effect, no throw — the delivery section then relies on auto-create.
    expect(true).toBe(true);
  });

  it("ensureTopic() tolerates an undefined harness (no-op)", async () => {
    await ensureTopic(undefined, "delta");
    expect(true).toBe(true);
  });
});
