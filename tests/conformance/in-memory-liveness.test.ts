// tests/conformance/in-memory-liveness.test.ts
//
// I9 / #28 — push-impl liveness. PUSH-GATED, NEVER CORE: this assertion lives in the
// InMemory (push) adapter's own conformance file, NOT in the shared suite.ts axis. A
// poll backend (SQLite) is decoupled by construction (publish = write-then-poll), so the
// "hung subscriber wedges publish" failure mode is push-specific (spec §4, F5).
//
// The fix under test: publish() snapshots the subscription set BEFORE fan-out and delivers
// to each subscriber independently — a slow/hung handler must NOT wedge publish() or starve
// a co-subscriber.

import { describe, it, expect } from "bun:test";
import {
  createBackplane,
  connectInMemoryPeer,
} from "../../src/adapters/in-memory/in-memory-pubsub";

// Two microtask ticks — same settle primitive the suite uses for push impls.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("InMemory push liveness (#28)", () => {
  it("a hung subscriber does not wedge publish()", async () => {
    const bp = createBackplane();
    const pub = await connectInMemoryPeer(bp, "pub");
    const hung = await connectInMemoryPeer(bp, "hung");

    // Subscribe before any publish so subscribe()'s own catch-up drain has nothing to
    // deliver and returns immediately; the hang is exercised by the live publish below.
    await hung.pubsub.subscribe("t", () => new Promise<void>(() => {})); // never resolves

    // publish() must resolve promptly even though the only subscriber's handler hangs.
    // Race its resolution against a 2-microtask sentinel: with the old serial-await
    // fan-out, publish never resolves and "pending" wins (RED). Decoupled, "resolved" wins.
    const outcome = await Promise.race([
      pub.pubsub.publish("t", "hello").then(() => "resolved" as const),
      flush().then(() => "pending" as const),
    ]);
    expect(outcome).toBe("resolved");
  });

  it("a hung subscriber does not starve a co-subscriber", async () => {
    const bp = createBackplane();
    const pub = await connectInMemoryPeer(bp, "pub");
    const hung = await connectInMemoryPeer(bp, "hung");
    const fast = await connectInMemoryPeer(bp, "fast");
    const fastGot: string[] = [];

    // hung subscribes FIRST — under the old serial-await loop it would block the loop
    // before `fast` is ever drained, starving fast.
    await hung.pubsub.subscribe("t", () => new Promise<void>(() => {}));
    await fast.pubsub.subscribe("t", (m) => {
      fastGot.push(m.data);
    });

    await pub.pubsub.publish("t", "hello");
    await flush();

    expect(fastGot).toEqual(["hello"]);
  });
});
