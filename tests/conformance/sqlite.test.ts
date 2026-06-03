// tests/conformance/sqlite.test.ts
//
// Conformance wiring for the SQLite adapter. The harness factory constructs the FULL chain
// — Database + repos (bun:sqlite, test-only) → MessagingService (core) → SQLite adapter —
// proving the composition boundary: concrete storage is injected at the harness, NEVER
// imported by the adapter (archunit hexagonal-boundaries.test.ts:192, adapters ↛ storage).
//
// CORE DELIVERY LIVE (I6): the adapter implements publish/subscribe/replayFrom over the
// pump()/poll seam, so runConformanceSuite runs UNCONDITIONALLY — the I4-I5 pre-CORE gate
// (SQLITE_CORE_DELIVERY_READY) is REMOVED (architect ruling #2687, rule 2; atomic un-gate).
// CORE + the topicLifecycle:"explicit" reject section pass; the implicit-lifecycle branch
// (caps-inherent — SQLite is explicit), durable (→I7), and at-least-once (→I8) sections remain
// descriptor-gated skips, VISIBLE + named by the suite's skipIf(caps), each tied to its
// flipping slice (no silent cap, rule 3). The descriptor test asserts the truthful PROGRESSIVE
// descriptor (rule 1) — {durable:false, at-most-once} here, reaching the final 4-axis by I8.

import { describe, it, expect } from "bun:test";
import { createDb } from "../../src/storage/sqlite/db";
import { runMigrations, allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { MessagingService } from "../../src/core/messaging/service";
import { createSqliteBackplane, connectSqlitePeer, pump } from "../../src/adapters/sqlite/sqlite-pubsub";
import { cleanupDb } from "../helpers/db";
import type { ConformanceHarness, HarnessFactory } from "./harness";
import { runConformanceSuite } from "./suite";

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
  // A registered agent to own out-of-band topic creation (control plane). CORE topics are
  // plain channels (not DMs), so createChannel needs only a registered creator.
  svc.register("__provisioner__");
  // The adapter's hidden, process-local delivery backplane over this one DB connection.
  const bp = createSqliteBackplane(svc);
  return {
    connect: async (name) => connectSqlitePeer(bp, name),
    // R6 α poll tick: one deterministic, timer-free pump() drive (I5 seam).
    advance: async () => pump(bp),
    // I5.5 provision seam: explicit topicLifecycle → create the topic out-of-band (control
    // plane) so the DELIVERY sections can exercise it; the lifecycle-reject sections do not call it.
    provision: async (topic) => {
      svc.createChannel("__provisioner__", topic);
    },
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

// Gate removed (I6): CORE delivery + topicLifecycle:"explicit" reject are implemented, so the
// suite runs unconditionally. durable + at-least-once remain descriptor-gated skips until I7/I8.
await runConformanceSuite("SQLite", sqliteFactory);
