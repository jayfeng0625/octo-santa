// tests/conformance/sqlite.test.ts
//
// Conformance wiring for the SQLite adapter. The harness factory constructs the FULL chain
// — Database + repos (bun:sqlite, test-only) → MessagingService (core) → SQLite adapter —
// proving the composition boundary: concrete storage is injected at the harness, NEVER
// imported by the adapter (archunit hexagonal-boundaries.test.ts:192, adapters ↛ storage).
//
// PRE-CORE GATE (architect ruling, os-rewrite #2687, rule 2): the adapter has no CORE
// delivery yet (publish/subscribe/replayFrom land in I6 via the pump()/poll seam), so the
// ungated CORE suite would red-fail. The whole runConformanceSuite invocation is gated
// behind ONE named flag, REMOVED in I6. Until then it shows as a single VISIBLE, NAMED skip
// (rule 3: no silent caps). The descriptor test below runs green now and asserts the
// truthful PROGRESSIVE descriptor (rule 1), which grows to the final 4-axis by I8.

import { describe, it, expect } from "bun:test";
import { createDb } from "../../src/storage/sqlite/db";
import { runMigrations, allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { MessagingService } from "../../src/core/messaging/service";
import { connectSqlitePeer } from "../../src/adapters/sqlite/sqlite-pubsub";
import { cleanupDb } from "../helpers/db";
import type { ConformanceHarness, HarnessFactory } from "./harness";
import { runConformanceSuite } from "./suite";

// ← Flip true / remove in I6 when CORE delivery (publish/subscribe/replayFrom via pump) lands.
const SQLITE_CORE_DELIVERY_READY = false;

let dbSeq = 0;

/** Fresh hermetic temp-DB backplane per call (spec §4): db → repos → svc → adapter. */
function makeHarness(): ConformanceHarness {
  const dbPath = `/tmp/octo-santa-conformance-sqlite-${process.pid}-${dbSeq++}.sqlite`;
  cleanupDb(dbPath);
  const db = createDb(dbPath);
  runMigrations(db, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(
    repos.agents,
    repos.channels,
    repos.messages,
    repos.cursors,
    process.pid
  );
  return {
    connect: async (name) => connectSqlitePeer(svc, name),
    cleanup: async () => {
      db.close();
      cleanupDb(dbPath);
    },
    // reopen() (durable restart seam) lands in I7.
  };
}

const sqliteFactory: HarnessFactory = async () => makeHarness();

describe("SQLite adapter (I4 — skeleton + descriptor)", () => {
  it("declares the progressive capability descriptor (truthful to what is built)", async () => {
    const h = makeHarness();
    const peer = await h.connect("probe");
    expect(peer.pubsub.capabilities).toEqual({
      durable: false, // → true in I7
      replayable: true,
      delivery: "at-most-once", // → "at-least-once" in I8
      topicLifecycle: "explicit",
    });
    await h.cleanup();
  });
});

if (SQLITE_CORE_DELIVERY_READY) {
  await runConformanceSuite("SQLite", sqliteFactory);
} else {
  describe("PubSub conformance — SQLite", () => {
    it.skip("gated until I6 — CORE delivery (publish/subscribe/replayFrom via pump) not yet implemented", () => {});
  });
}
