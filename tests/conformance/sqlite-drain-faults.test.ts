// tests/conformance/sqlite-drain-faults.test.ts
//
// R1 (remediation) — drain failure handling for the SQLite PubSub adapter. ADAPTER-LEVEL, NOT
// the shared conformance suite: these tests INJECT a faulting cursor write (a storage fault the
// shared suite cannot express without a per-impl branch, which the keystone forbids). They prove
// F1 (a floated drain rejection is contained, never an unhandled rejection), partial-cursor-commit
// (persist-then-advance keeps in-memory and durable cursors consistent on a persist throw), and
// F2 (a NACK is logged, never silently swallowed).
//
// Builds the real chain (db → repos → MessagingService → adapter) and wraps ONLY the cursors repo
// so `set` throws on demand — the faithful advanceCursor → CursorRepo.set rethrow path.

import { describe, it, expect, spyOn } from "bun:test";
import { createDb } from "../../src/storage/sqlite/db";
import { runMigrations, allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { MessagingService } from "../../src/core/messaging/service";
import type { CursorRepository } from "../../src/core/ports";
import {
  createSqliteBackplane,
  connectSqlitePeer,
  pump,
  type SqliteBackplane,
} from "../../src/adapters/sqlite/sqlite-pubsub";
import { cleanupDb } from "../helpers/db";
import * as logModule from "../../src/log";

let seq = 0;

/** Real chain, with the cursors repo wrapped so `set` throws when the fault is armed. */
function makeFaultHarness() {
  const dbPath = `/tmp/octo-santa-drain-fault-${process.pid}-${seq++}.sqlite`;
  cleanupDb(dbPath);
  const db = createDb(dbPath);
  runMigrations(db, allMigrations);
  const repos = createSqliteRepos(db);

  const fault = { armed: false };
  const cursors: CursorRepository = {
    get: (a, c) => repos.cursors.get(a, c),
    getRead: (a, c) => repos.cursors.getRead(a, c),
    set: (a, c, id) => {
      if (fault.armed) throw new Error("injected cursor write fault");
      repos.cursors.set(a, c, id);
    },
    listForAgent: (a) => repos.cursors.listForAgent(a),
  };

  const svc = new MessagingService(
    repos.agents,
    repos.channels,
    repos.messages,
    cursors,
    process.pid
  );
  svc.register("__provisioner__");
  const bp: SqliteBackplane = createSqliteBackplane(svc);

  return {
    svc,
    bp,
    fault,
    cleanup: () => {
      db.close();
      cleanupDb(dbPath);
    },
  };
}

/** Let floated drain microtasks (and any unhandled rejection) settle. */
const flush = () => new Promise((r) => setTimeout(r, 30));

describe("R1 — SQLite drain failure handling", () => {
  it("contains a faulting cursor-advance: no unhandled rejection, cursors stay consistent + held, redelivers next tick", async () => {
    const h = makeFaultHarness();
    h.svc.createChannel("__provisioner__", "topic");
    const pub = connectSqlitePeer(h.bp, "pub");
    const sub = connectSqlitePeer(h.bp, "sub");

    const received: string[] = [];
    await sub.pubsub.subscribe("topic", async (m) => {
      received.push(m.data);
    });
    await pub.pubsub.publish("topic", "m1");

    const rejections: string[] = [];
    const onRej = (e: unknown) =>
      rejections.push(String((e as Error)?.message ?? e));
    process.on("unhandledRejection", onRej);
    try {
      h.fault.armed = true;
      await pump(h.bp);
      await flush();

      // delivery happened (handler ran once)
      expect(received).toEqual(["m1"]);

      // partial-commit guard: in-memory cursor === persisted cursor (no split state)
      const inMem = h.bp.subscriptions[0]!.cursor;
      const persisted = h.svc.getCursorPosition("sub", "topic");
      expect(inMem).toBe(persisted);

      // the injected fault did NOT escape drain as an unhandled rejection
      expect(
        rejections.filter((m) => m.includes("injected cursor write fault"))
      ).toEqual([]);

      // disarm → the held message redelivers on the next tick (at-least-once)
      h.fault.armed = false;
      await pump(h.bp);
      await flush();
      expect(received).toEqual(["m1", "m1"]);
    } finally {
      process.off("unhandledRejection", onRej);
      h.cleanup();
    }
  });

  it("logs the NACK when a handler throws (no silent swallow)", async () => {
    const h = makeFaultHarness();
    h.svc.createChannel("__provisioner__", "topic");
    const pub = connectSqlitePeer(h.bp, "pub");
    const sub = connectSqlitePeer(h.bp, "sub");

    const spy = spyOn(logModule, "log").mockImplementation(() => {});
    try {
      await sub.pubsub.subscribe("topic", async () => {
        throw new Error("poison");
      });
      await pub.pubsub.publish("topic", "m1");
      await pump(h.bp);
      await flush();

      const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("NACK");
    } finally {
      spy.mockRestore();
      h.cleanup();
    }
  });
});

describe("R3 — SQLite drain batch catch-up", () => {
  it("delivers a cursor-0 backlog in one tick with batched reads, not one-query-per-message", async () => {
    const h = makeFaultHarness();
    h.svc.createChannel("__provisioner__", "topic");
    connectSqlitePeer(h.bp, "pub");
    const K = 600; // > READ_BATCH (500) → at least 2 batches
    // Seed the backlog directly (human:true resets the hop counter so K > maxHops is allowed);
    // the test exercises the DRAIN's batched read, not the publish path.
    for (let i = 0; i < K; i++) h.svc.send("pub", "topic", `m${i}`, { human: true });

    const sub = connectSqlitePeer(h.bp, "sub");
    const received: string[] = [];
    await sub.pubsub.subscribe("topic", async (m) => {
      received.push(m.data);
    });

    const spy = spyOn(h.svc, "replayMessages");
    try {
      await pump(h.bp);
      await flush();

      // whole backlog delivered, in order, on a single tick
      expect(received.length).toBe(K);
      expect(received[0]).toBe("m0");
      expect(received[K - 1]).toBe(`m${K - 1}`);

      // batched: ceil(K/READ_BATCH) reads + 1 end-of-log read — NOT K+1 single-row reads
      expect(spy.mock.calls.length).toBeLessThanOrEqual(Math.ceil(K / 500) + 1);
    } finally {
      spy.mockRestore();
      h.cleanup();
    }
  });

  it("HOL holds inside a batch: a NACK mid-batch stops delivery, redelivers from the NACKed message", async () => {
    const h = makeFaultHarness();
    h.svc.createChannel("__provisioner__", "topic");
    const pub = connectSqlitePeer(h.bp, "pub");
    for (let i = 0; i < 5; i++) await pub.pubsub.publish("topic", `m${i}`); // ids 1..5, one batch

    const sub = connectSqlitePeer(h.bp, "sub");
    const received: string[] = [];
    let failOn: string | null = "m2";
    await sub.pubsub.subscribe("topic", async (m) => {
      if (m.data === failOn) throw new Error("poison");
      received.push(m.data);
    });

    await pump(h.bp);
    await flush();
    // delivered m0,m1 then NACK at m2 → m3,m4 NOT delivered past the head-of-line block
    expect(received).toEqual(["m0", "m1"]);

    // heal the poison → next tick redelivers from m2 onward
    failOn = null;
    await pump(h.bp);
    await flush();
    expect(received).toEqual(["m0", "m1", "m2", "m3", "m4"]);

    h.cleanup();
  });
});

describe("I10 — SQLite push/pull cursor isolation", () => {
  it("push delivers every message regardless of pull-cursor advancement (independent cursors, no loss)", async () => {
    const h = makeFaultHarness();
    h.svc.createChannel("__provisioner__", "topic");
    const self = connectSqlitePeer(h.bp, "self");
    connectSqlitePeer(h.bp, "other");

    // other + self each publish; self has NOT push-subscribed yet.
    h.svc.send("other", "topic", "o1");
    h.svc.send("self", "topic", "s1");

    // self PULLS via read_messages → advances the PULL cursor (last_read_message_id) past "o1"
    // (the pull path excludes self-authored "s1").
    const pulled = h.svc.read("self", "topic");
    expect(pulled.map((m) => m.content)).toEqual(["o1"]);

    // NOW self push-subscribes. getCursorPosition must read the PUSH delivery cursor
    // (delivery_cursor = 0), NOT the pull-advanced last_read_message_id — else "o1" is lost.
    const received: string[] = [];
    await self.pubsub.subscribe("topic", async (m) => {
      received.push(m.data);
    });
    await pump(h.bp);
    await flush();

    // push delivers BOTH (at-least-once includes self-authored) — zero loss from the pull read.
    expect(received).toEqual(["o1", "s1"]);

    h.cleanup();
  });
});
