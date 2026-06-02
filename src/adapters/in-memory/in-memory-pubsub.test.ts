import { describe, it, expect } from "bun:test";
import type { Message, Cursor } from "../../contracts";
import { createBackplane, connectInMemoryPeer } from "./in-memory-pubsub";

// Small helper: lets a test await until a predicate holds, since delivery is
// driven synchronously by publish but onMessage handlers may be async.
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("InMemoryPubSub — descriptor", () => {
  it("declares the spec-mandated capability descriptor", async () => {
    const bp = createBackplane();
    const a = await connectInMemoryPeer(bp, "a");
    expect(a.pubsub.capabilities).toEqual({
      durable: false,
      replayable: true,
      delivery: "at-least-once",
      topicLifecycle: "implicit",
    });
  });
});

describe("InMemoryPubSub — publish/subscribe core", () => {
  it("delivers a published message to a subscriber with from === publisher id", async () => {
    const bp = createBackplane();
    const a = await connectInMemoryPeer(bp, "a");
    const got: Message[] = [];
    await a.pubsub.subscribe("t", (m) => {
      got.push(m);
    });
    await a.pubsub.publish("t", "hello");
    await flush();
    expect(got.length).toBe(1);
    expect(got[0]!.data).toBe("hello");
    expect(got[0]!.topic).toBe("t");
    expect(got[0]!.from).toBe(a.id);
  });

  it("preserves per-topic FIFO ordering", async () => {
    const bp = createBackplane();
    const a = await connectInMemoryPeer(bp, "a");
    const got: string[] = [];
    await a.pubsub.subscribe("t", (m) => {
      got.push(m.data);
    });
    await a.pubsub.publish("t", "1");
    await a.pubsub.publish("t", "2");
    await a.pubsub.publish("t", "3");
    await flush();
    expect(got).toEqual(["1", "2", "3"]);
  });

  it("delivers cross-peer: peer A publishes, peer B (different identity, same backplane) receives", async () => {
    const bp = createBackplane();
    const a = await connectInMemoryPeer(bp, "a");
    const b = await connectInMemoryPeer(bp, "b");
    const got: Message[] = [];
    await b.pubsub.subscribe("room", (m) => {
      got.push(m);
    });
    await a.pubsub.publish("room", "from-a");
    await flush();
    expect(got.length).toBe(1);
    expect(got[0]!.data).toBe("from-a");
    expect(got[0]!.from).toBe(a.id);
  });

  it("does not cross-contaminate between separate backplane instances", async () => {
    const bp1 = createBackplane();
    const bp2 = createBackplane();
    const a = await connectInMemoryPeer(bp1, "a");
    const b = await connectInMemoryPeer(bp2, "b");
    const got: Message[] = [];
    await b.pubsub.subscribe("t", (m) => {
      got.push(m);
    });
    await a.pubsub.publish("t", "x");
    await flush();
    expect(got.length).toBe(0);
  });
});

describe("InMemoryPubSub — implicit topic lifecycle (auto-create symmetry)", () => {
  it("subscribe to an unknown topic auto-creates it (empty, no error)", async () => {
    const bp = createBackplane();
    const a = await connectInMemoryPeer(bp, "a");
    const got: Message[] = [];
    await a.pubsub.subscribe("never-seen", (m) => {
      got.push(m);
    });
    await flush();
    expect(got.length).toBe(0); // empty, no error
    await a.pubsub.publish("never-seen", "live");
    await flush();
    expect(got.map((m) => m.data)).toEqual(["live"]);
  });

  it("publish to an unknown topic auto-creates it (never an error)", async () => {
    const bp = createBackplane();
    const a = await connectInMemoryPeer(bp, "a");
    await a.pubsub.publish("brand-new", "x"); // must not throw
    const got: Message[] = [];
    await a.pubsub.subscribe("brand-new", (m) => {
      got.push(m);
    });
    await flush();
    expect(got.map((m) => m.data)).toEqual(["x"]); // catch-up from backlog
  });
});

describe("InMemoryPubSub — catch-up from cursor 0", () => {
  it("a brand-new subscriber receives the full backlog in order, then live", async () => {
    const bp = createBackplane();
    const a = await connectInMemoryPeer(bp, "a");
    await a.pubsub.publish("t", "1");
    await a.pubsub.publish("t", "2");
    const b = await connectInMemoryPeer(bp, "b");
    const got: string[] = [];
    await b.pubsub.subscribe("t", (m) => {
      got.push(m.data);
    });
    await flush();
    expect(got).toEqual(["1", "2"]); // full backlog
    await a.pubsub.publish("t", "3");
    await flush();
    expect(got).toEqual(["1", "2", "3"]); // then live
  });
});

describe("InMemoryPubSub — at-least-once NACK / HOL", () => {
  it("NACK holds the cursor and the message is redelivered on the next cycle", async () => {
    const bp = createBackplane();
    const a = await connectInMemoryPeer(bp, "a");
    const attempts: string[] = [];
    let failFirst = true;
    await a.pubsub.subscribe("t", (m) => {
      attempts.push(m.data);
      if (m.data === "n" && failFirst) {
        failFirst = false;
        throw new Error("boom");
      }
    });
    await a.pubsub.publish("t", "n");
    await flush();
    // delivered once and NACKed; not synchronously retried
    expect(attempts).toEqual(["n"]);
    // next cycle (a subsequent publish) re-reads forward from the held cursor
    await a.pubsub.publish("t", "next");
    await flush();
    // "n" redelivered (acked this time), then "next"
    expect(attempts).toEqual(["n", "n", "next"]);
  });

  it("head-of-line: a NACKed N blocks N+1 until N ACKs", async () => {
    const bp = createBackplane();
    const a = await connectInMemoryPeer(bp, "a");
    const attempts: string[] = [];
    let nFails = true;
    await a.pubsub.subscribe("t", (m) => {
      attempts.push(m.data);
      if (m.data === "N" && nFails) {
        throw new Error("hold N");
      }
    });
    await a.pubsub.publish("t", "N");
    await flush();
    // N delivered + NACKed; cursor holds
    expect(attempts).toEqual(["N"]);
    // publishing N+1 is itself a next cycle: N is redelivered (NACK again) and HOL
    // blocks N+1 — it must NOT appear while N is unacked.
    await a.pubsub.publish("t", "N+1");
    await flush();
    expect(attempts).toEqual(["N", "N"]);
    // let N succeed, trigger next cycle
    nFails = false;
    await a.pubsub.publish("t", "N+2");
    await flush();
    // this cycle redelivers N (now acks), then N+1, then N+2 — all in order
    expect(attempts).toEqual(["N", "N", "N", "N+1", "N+2"]);
  });
});

describe("InMemoryPubSub — unsubscribe stop-only", () => {
  it("re-subscribe resumes from the held cursor, not from 0", async () => {
    const bp = createBackplane();
    const a = await connectInMemoryPeer(bp, "a");
    const got: string[] = [];
    await a.pubsub.subscribe("t", (m) => {
      got.push(m.data);
    });
    await a.pubsub.publish("t", "1");
    await flush();
    expect(got).toEqual(["1"]);
    await a.pubsub.unsubscribe("t");
    // published while unsubscribed — not delivered now
    await a.pubsub.publish("t", "2");
    await flush();
    expect(got).toEqual(["1"]);
    // re-subscribe resumes from held cursor (after "1"), NOT from 0
    await a.pubsub.subscribe("t", (m) => {
      got.push(m.data);
    });
    await flush();
    expect(got).toEqual(["1", "2"]); // only the missed "2", not "1" again
  });

  it("re-subscribe to an active topic replaces the handler, cursor unchanged", async () => {
    const bp = createBackplane();
    const a = await connectInMemoryPeer(bp, "a");
    const first: string[] = [];
    const second: string[] = [];
    await a.pubsub.subscribe("t", (m) => {
      first.push(m.data);
    });
    await a.pubsub.publish("t", "1");
    await flush();
    // replace handler WITHOUT unsubscribe; cursor stays where it is
    await a.pubsub.subscribe("t", (m) => {
      second.push(m.data);
    });
    await a.pubsub.publish("t", "2");
    await flush();
    expect(first).toEqual(["1"]);
    expect(second).toEqual(["2"]); // new handler gets only post-replacement messages
  });
});

describe("InMemoryPubSub — replayFrom exclusivity", () => {
  it("reads strictly after the given cursor and does not self-exclude semantics", async () => {
    const bp = createBackplane();
    const a = await connectInMemoryPeer(bp, "a");
    const live: Message[] = [];
    await a.pubsub.subscribe("t", (m) => {
      live.push(m);
    });
    await a.pubsub.publish("t", "1");
    await a.pubsub.publish("t", "2");
    await a.pubsub.publish("t", "3");
    await flush();
    expect(live.map((m) => m.data)).toEqual(["1", "2", "3"]);

    const cursorOf1: Cursor = live[0]!.cursor;
    const replayed: string[] = [];
    await a.pubsub.replayFrom("t", cursorOf1, (m) => {
      replayed.push(m.data);
    });
    await flush();
    // strictly after "1" → "2","3" (excludes the cursor message itself)
    expect(replayed).toEqual(["2", "3"]);
  });

  it("does not advance the subscription cursor", async () => {
    const bp = createBackplane();
    const a = await connectInMemoryPeer(bp, "a");
    const live: Message[] = [];
    await a.pubsub.subscribe("t", (m) => {
      live.push(m);
    });
    await a.pubsub.publish("t", "1");
    await a.pubsub.publish("t", "2");
    await flush();
    const cursorOf1 = live[0]!.cursor;

    // replay does NOT mutate subscription state
    const replayed: string[] = [];
    await a.pubsub.replayFrom("t", cursorOf1, (m) => {
      replayed.push(m.data);
    });
    await flush();
    expect(replayed).toEqual(["2"]);

    // subscription cursor untouched → next live publish still delivered exactly once
    await a.pubsub.publish("t", "3");
    await flush();
    expect(live.map((m) => m.data)).toEqual(["1", "2", "3"]);
  });
});

describe("InMemoryPubSub — peer discovery", () => {
  it("list() returns the known peers on the backplane", async () => {
    const bp = createBackplane();
    const a = await connectInMemoryPeer(bp, "a");
    const b = await connectInMemoryPeer(bp, "b");
    const peers = await a.discovery.list();
    expect([...peers].sort()).toEqual([a.id, b.id].sort());
    // b sees the same backplane
    const fromB = await b.discovery.list();
    expect([...fromB].sort()).toEqual([a.id, b.id].sort());
  });
});
