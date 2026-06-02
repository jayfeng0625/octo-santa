// tests/contracts/brand-enforcement.test.ts
//
// Compile-time proof (spec §1 B, §4 suite invariant): a raw string literal CANNOT
// be assigned to a branded `Cursor` or `PeerId`. The brand makes a raw-literal a
// COMPILE error — consumers round-trip ids, never construct them.
//
// The `@ts-expect-error` directives below are the assertion: `bunx tsc --noEmit`
// (which typechecks this file) FAILS if any directive becomes unused — i.e. if the
// brand stops blocking raw-string assignment. The runtime test exists so `bun test`
// also executes this file.

import { describe, it, expect } from "bun:test";
import { asPeerId, asCursor } from "../../src/contracts/index.ts";
import type { PeerId, Cursor } from "../../src/contracts/index.ts";

describe("branded ids — compile-time enforcement", () => {
  it("rejects raw string literals assigned to PeerId / Cursor", () => {
    // @ts-expect-error — raw string is NOT assignable to PeerId (brand enforced)
    const badPeer: PeerId = "peer-1";
    // @ts-expect-error — raw string is NOT assignable to Cursor (brand enforced)
    const badCursor: Cursor = "cursor-1";

    // Mint helpers (adapter-internal) are the ONLY way to construct a branded id.
    const goodPeer: PeerId = asPeerId("peer-1");
    const goodCursor: Cursor = asCursor("cursor-1");

    // Branded ids round-trip back to their underlying string value.
    expect(goodPeer as string).toBe("peer-1");
    expect(goodCursor as string).toBe("cursor-1");
    // Reference the @ts-expect-error bindings so they are not flagged unused at runtime.
    expect(typeof badPeer).toBe("string");
    expect(typeof badCursor).toBe("string");
  });
});
