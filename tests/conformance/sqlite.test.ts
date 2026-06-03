// tests/conformance/sqlite.test.ts
//
// Conformance wiring for the SQLite adapter. The harness factory constructs the FULL chain
// — Database + repos (bun:sqlite, test-only) → MessagingService (core) → SQLite adapter —
// proving the composition boundary: concrete storage is injected at the harness, NEVER
// imported by the adapter (archunit hexagonal-boundaries.test.ts:192, adapters ↛ storage).
//
// CORE DELIVERY LIVE (I6) + DURABLE (I7): the adapter implements publish/subscribe/replayFrom
// over the pump()/poll seam (I6, un-gated) and restart-survival via the reopen() harness seam
// (I7). runConformanceSuite runs UNCONDITIONALLY. CORE + topicLifecycle:"explicit" reject +
// durable (cross-process/restart replay) all pass; the implicit-lifecycle branch (caps-inherent
// — SQLite is explicit) and at-least-once (→I8) sections remain descriptor-gated skips, VISIBLE
// + named by the suite's skipIf(caps), tied to their flipping slice (no silent cap). The
// descriptor test asserts the truthful PROGRESSIVE descriptor — {durable:true, at-most-once}
// here, reaching the final 4-axis at I8.

import { describe, it, expect } from "bun:test";
import { createDb } from "../../src/storage/sqlite/db";
import { runMigrations, allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { MessagingService } from "../../src/core/messaging/service";
import { createSqliteBackplane, connectSqlitePeer, pump, type SqliteBackplane } from "../../src/adapters/sqlite/sqlite-pubsub";
import { cleanupDb } from "../helpers/db";
import type { ConformanceHarness, HarnessFactory } from "./harness";
import { runConformanceSuite } from "./suite";

let dbSeq = 0;

/** Fresh hermetic temp-DB backplane per call (spec §4): db → repos → svc → adapter. */
function makeHarness(): ConformanceHarness {
  const dbPath = `/tmp/octo-santa-conformance-sqlite-${process.pid}-${dbSeq++}.sqlite`;
  cleanupDb(dbPath);

  // Mutable session shared across reopen() generations. The harness methods read `bp` LAZILY,
  // so when reopen() swaps it (simulated restart — drop the in-process connection + delivery
  // registry, KEEP the file), the ORIGINAL handle and the reopened handle both drive the
  // post-restart backplane. That is what lets the durable test `settle(harness)` yet deliver to
  // a peer connected via the reopened handle.
  const session: {
    db: ReturnType<typeof createDb> | undefined;
    bp: SqliteBackplane | undefined;
    closed: boolean;
  } = { db: undefined, bp: undefined, closed: false };

  function open(): void {
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
    // A registered agent owns out-of-band topic creation (control plane). CORE topics are
    // plain channels (not DMs), so createChannel needs only a registered creator.
    svc.register("__provisioner__");
    session.db = db;
    // Fresh delivery backplane: a restart drops in-process subscriptions, never the store.
    session.bp = createSqliteBackplane(svc);
  }
  open();

  function harness(): ConformanceHarness {
    return {
      connect: async (name) => connectSqlitePeer(session.bp!, name),
      // R6 α poll tick: one deterministic, timer-free pump() drive (I5 seam).
      advance: async () => pump(session.bp!),
      // I5.5 provision seam: explicit topicLifecycle → create the topic out-of-band (control
      // plane) so the DELIVERY sections can exercise it; lifecycle-reject sections do not call it.
      provision: async (topic) => {
        session.bp!.svc.createChannel("__provisioner__", topic);
      },
      // I7 durable restart seam: close the live connection + reopen the SAME temp DB file (the
      // store persists; the in-process delivery registry does not). One connection per process —
      // close BEFORE reopen. Returns a fresh handle over the same lazily-read session.
      reopen: async () => {
        session.db!.close();
        open();
        return harness();
      },
      cleanup: async () => {
        if (session.closed) return; // idempotent: reopen shares one session; close + delete once
        session.closed = true;
        session.db!.close();
        cleanupDb(dbPath);
      },
    };
  }
  return harness();
}

const sqliteFactory: HarnessFactory = async () => makeHarness();

describe("SQLite adapter (I4 — skeleton + descriptor)", () => {
  it("declares the progressive capability descriptor (truthful to what is built)", async () => {
    const h = makeHarness();
    const peer = await h.connect("probe");
    expect(peer.pubsub.capabilities).toEqual({
      durable: true, // I7: restart-survival via the reopen() harness seam
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
