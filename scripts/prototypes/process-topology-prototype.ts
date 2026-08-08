/**
 * PROTOTYPE/WIPE: disposable OS-process and SQLite/WAL topology evidence only.
 * Exact question: Should the local gateway end state use one central single-writer daemon or federated N-writer processes, and what does a bounded dual-plane overlap prove?
 * Assumption: A Delivery is model-visible only after a separate observation, repository plus source ID is the idempotency scope, and strict ordering is per Route Binding rather than global.
 *
 * Run: bun scripts/prototypes/process-topology-prototype.ts
 */

import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const QUESTION =
  "Should the local gateway end state use one central single-writer daemon or federated N-writer processes, and what does a bounded dual-plane overlap prove?";
const ASSUMPTION =
  "A Delivery is model-visible only after a separate observation, repository plus source ID is the idempotency scope, and strict ordering is per Route Binding rather than global.";
const scriptPath = realpathSync(import.meta.path);

type Delivery = {
  id: string;
  repository: string;
  source_id: string;
  route_binding: string;
  route_seq: number;
  payload: string;
  state: "queued" | "submitted" | "visible";
  harness_receipt: string | null;
};

type Command =
  | { op: "enqueue"; input: SourceInput; crash?: "before-commit" | "after-commit-before-ack" }
  | { op: "record-submission"; deliveryId: string; receipt: string; crash?: "after-submit-before-observation" }
  | { op: "record-observation"; deliveryId: string }
  | { op: "checkpoint" }
  | { op: "state" }
  | { op: "shutdown" };

type EnqueueCrash = "before-commit" | "after-commit-before-ack";

type SourceInput = {
  repository: string;
  sourceId: string;
  routeBinding: string;
  payload: string;
  sourcePid: number;
};

type ScenarioResult = {
  topology: "central" | "federated";
  observedSqliteWriterRoles: string[];
  processChain: { source: number; enqueue: number; harness: number; observer: number; modelReader: number };
  crossProcessVisible: boolean;
  receiptWasNotVisibility: boolean;
  offlineReplay: boolean;
  strictRouteOrdering: boolean;
  unrelatedRouteProgress: boolean;
  repositoryScopedIdempotency: boolean;
  beforeCommitRecoveredByRetry: boolean;
  afterCommitRetryReturnedOriginal: boolean;
  submittedBeforeObservationRecovered: boolean;
  processRestartRecovered: boolean;
  failureIsolation: string;
  lifecycleOwnership: string;
  operationalRequirements: string[];
  crashEvidence: Record<string, unknown>;
};

function openDb(path: string, initialize = true): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA busy_timeout = 2000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  if (initialize) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS prototype_migrations (
        version INTEGER PRIMARY KEY,
        owner_pid INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        source_id TEXT NOT NULL,
        route_binding TEXT NOT NULL,
        route_seq INTEGER NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'submitted', 'visible')),
        harness_receipt TEXT,
        UNIQUE (repository, source_id),
        UNIQUE (route_binding, route_seq)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_pid INTEGER NOT NULL,
        role TEXT NOT NULL,
        action TEXT NOT NULL,
        delivery_id TEXT,
        detail TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS route_owners (
        route_binding TEXT PRIMARY KEY,
        plane TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dual_deliveries (
        id TEXT PRIMARY KEY,
        plane TEXT NOT NULL,
        repository TEXT NOT NULL,
        source_id TEXT NOT NULL,
        route_binding TEXT NOT NULL,
        route_seq INTEGER NOT NULL,
        state TEXT NOT NULL,
        UNIQUE (plane, repository, source_id)
      );
    `);
    db.query("INSERT OR IGNORE INTO prototype_migrations(version, owner_pid) VALUES (1, ?)").run(process.pid);
  }
  return db;
}

function event(db: Database, role: string, action: string, deliveryId: string | null, detail: unknown): void {
  db.query(
    "INSERT INTO events(actor_pid, role, action, delivery_id, detail) VALUES (?, ?, ?, ?, ?)",
  ).run(process.pid, role, action, deliveryId, JSON.stringify(detail));
}

function deliveryBySource(db: Database, repository: string, sourceId: string): Delivery | null {
  return db
    .query("SELECT * FROM deliveries WHERE repository = ? AND source_id = ?")
    .get(repository, sourceId) as Delivery | null;
}

function deliveryById(db: Database, id: string): Delivery | null {
  return db.query("SELECT * FROM deliveries WHERE id = ?").get(id) as Delivery | null;
}

function enqueue(db: Database, role: string, input: SourceInput, crash?: EnqueueCrash): Delivery {
  if (crash === "before-commit") {
    event(db, role, "crash-window-before-delivery-commit", null, input);
    db.close();
    process.exit(81);
  }

  db.exec("BEGIN IMMEDIATE");
  const existing = deliveryBySource(db, input.repository, input.sourceId);
  if (existing) {
    event(db, role, "source-retry-returned-original", existing.id, {
      repository: input.repository,
      sourceId: input.sourceId,
    });
    db.exec("COMMIT");
    return existing;
  }

  const nextNumber = Number(
    (db.query("SELECT count(*) AS count FROM deliveries").get() as { count: number }).count,
  ) + 1;
  const nextSequence = Number(
    (
      db
        .query("SELECT coalesce(max(route_seq), 0) + 1 AS seq FROM deliveries WHERE route_binding = ?")
        .get(input.routeBinding) as { seq: number }
    ).seq,
  );
  const id = `D-${String(nextNumber).padStart(3, "0")}`;
  db.query(
    `INSERT INTO deliveries(id, repository, source_id, route_binding, route_seq, payload, state)
     VALUES (?, ?, ?, ?, ?, ?, 'queued')`,
  ).run(id, input.repository, input.sourceId, input.routeBinding, nextSequence, input.payload);
  event(db, role, "durable-enqueue-commit", id, {
    repository: input.repository,
    sourceId: input.sourceId,
    routeBinding: input.routeBinding,
    routeSeq: nextSequence,
    sourcePid: input.sourcePid,
  });
  db.exec("COMMIT");

  const created = deliveryById(db, id)!;
  if (crash === "after-commit-before-ack") {
    db.close();
    process.exit(82);
  }
  return created;
}

function nextHarnessCandidate(db: Database): Delivery | null {
  return db
    .query(
      `SELECT d.*
       FROM deliveries d
       WHERE d.state = 'queued'
         AND NOT EXISTS (
           SELECT 1 FROM deliveries earlier
           WHERE earlier.route_binding = d.route_binding
             AND earlier.route_seq < d.route_seq
             AND earlier.state != 'visible'
         )
       ORDER BY d.id
       LIMIT 1`,
    )
    .get() as Delivery | null;
}

function recordSubmission(
  db: Database,
  role: string,
  deliveryId: string,
  receipt: string,
  crash?: "after-submit-before-observation",
): Delivery {
  db.exec("BEGIN IMMEDIATE");
  db.query("UPDATE deliveries SET state = 'submitted', harness_receipt = ? WHERE id = ?").run(receipt, deliveryId);
  event(db, role, "harness-submission-receipt", deliveryId, { receipt, modelVisible: false });
  db.exec("COMMIT");
  const submitted = deliveryById(db, deliveryId)!;
  if (crash === "after-submit-before-observation") {
    db.close();
    process.exit(83);
  }
  return submitted;
}

function recordObservation(db: Database, role: string, deliveryId: string): Delivery {
  db.exec("BEGIN IMMEDIATE");
  db.query("UPDATE deliveries SET state = 'visible' WHERE id = ? AND state = 'submitted'").run(deliveryId);
  event(db, role, "separate-model-observation", deliveryId, { modelVisible: true });
  db.exec("COMMIT");
  return deliveryById(db, deliveryId)!;
}

function state(path: string): { deliveries: Delivery[]; events: Record<string, unknown>[]; metadata: Record<string, string>[] } {
  const db = openDb(path, false);
  const result = {
    deliveries: db.query("SELECT * FROM deliveries ORDER BY id").all() as Delivery[],
    events: db.query("SELECT * FROM events ORDER BY id").all() as Record<string, unknown>[],
    metadata: db.query("SELECT * FROM metadata ORDER BY key").all() as Record<string, string>[],
  };
  db.close();
  return result;
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function parseWorkerResult(result: ReturnType<typeof Bun.spawnSync>): any {
  const text = result.stdout?.toString().trim() ?? "";
  return text ? JSON.parse(text.split("\n").at(-1)!) : null;
}

function worker(args: string[], expectSuccess = true): { result: any; pid: number; exitCode: number } {
  const child = Bun.spawnSync([process.execPath, scriptPath, "--worker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (expectSuccess && child.exitCode !== 0) {
    throw new Error(`worker failed (${child.exitCode}): ${child.stderr.toString()}`);
  }
  const parsed = parseWorkerResult(child);
  return { result: parsed, pid: parsed?.pid ?? -1, exitCode: child.exitCode };
}

function runWorkerMode(args: string[]): never | void {
  const mode = args[0]!;
  const path = args[1]!;
  const rest = args.slice(2);
  if (mode === "source") {
    emit({
      pid: process.pid,
      input: {
        repository: rest[0]!,
        sourceId: rest[1]!,
        routeBinding: rest[2]!,
        payload: rest[3]!,
        sourcePid: process.pid,
      } satisfies SourceInput,
    });
    return;
  }

  const topology = rest[0]!;
  const db = openDb(path, topology !== "central");
  const role = `${topology}-${mode}`;
  if (topology !== "central") {
    event(db, role, "process-opened-database", null, {
      path: realpathSync(path),
      journal: "WAL",
      synchronous: "FULL",
    });
  }
  if (topology === "federated") {
    event(db, role, "distributed-lifecycle-owner", null, {
      migrationAttempt: true,
      checkpointPolicy: "per-connection",
      discovery: realpathSync(path),
    });
  }

  if (mode === "enqueue") {
    const input = JSON.parse(rest[1]!) as SourceInput;
    const crash = rest[2] as EnqueueCrash | undefined;
    const delivery = enqueue(db, role, input, crash);
    emit({ pid: process.pid, delivery });
  } else if (mode === "harness-offline") {
    if (topology !== "central") event(db, role, "harness-offline-no-submission", null, {});
    emit({ pid: process.pid, candidate: nextHarnessCandidate(db), submitted: false });
  } else if (mode === "harness-probe") {
    const candidate = nextHarnessCandidate(db);
    emit({
      pid: process.pid,
      candidate,
      receipt: candidate ? `receipt-${candidate.id}` : null,
    });
  } else if (mode === "harness-probe-id") {
    const candidate = deliveryById(db, rest[1]!);
    emit({
      pid: process.pid,
      candidate,
      receipt: candidate ? `receipt-${candidate.id}` : null,
    });
  } else if (mode === "harness-submit") {
    const candidate = nextHarnessCandidate(db);
    if (!candidate) throw new Error("No eligible harness candidate");
    const receipt = `receipt-${candidate.id}`;
    const crash = rest[1] as "after-submit-before-observation" | undefined;
    const delivery = recordSubmission(db, role, candidate.id, receipt, crash);
    emit({ pid: process.pid, delivery, receipt });
  } else if (mode === "harness-submit-id") {
    const candidate = deliveryById(db, rest[1]!);
    if (!candidate || candidate.state !== "queued") throw new Error("Target Delivery is not queued");
    const receipt = `receipt-${candidate.id}`;
    const crash = rest[2] as "after-submit-before-observation" | undefined;
    const delivery = recordSubmission(db, role, candidate.id, receipt, crash);
    emit({ pid: process.pid, delivery, receipt });
  } else if (mode === "observer-probe") {
    const submitted = db
      .query("SELECT * FROM deliveries WHERE state = 'submitted' ORDER BY id LIMIT 1")
      .get() as Delivery | null;
    emit({ pid: process.pid, submitted });
  } else if (mode === "observer-record") {
    emit({ pid: process.pid, delivery: recordObservation(db, role, rest[1]!) });
  } else if (mode === "model-read") {
    const visible = db.query("SELECT * FROM deliveries WHERE state = 'visible' ORDER BY id").all() as Delivery[];
    emit({ pid: process.pid, visible });
  } else if (mode === "dual-unruled") {
    const [plane, repository, sourceId, route, sequence, id] = rest.slice(1);
    db.exec("BEGIN IMMEDIATE");
    db.query(
      "INSERT INTO dual_deliveries(id, plane, repository, source_id, route_binding, route_seq, state) VALUES (?, ?, ?, ?, ?, ?, 'submitted')",
    ).run(id!, plane!, repository!, sourceId!, route!, Number(sequence));
    event(db, role, "dual-plane-unruled-write", id!, { plane, sourceId, sequence: Number(sequence) });
    db.exec("COMMIT");
    emit({ pid: process.pid, id });
  } else if (mode === "dual-shared") {
    const [plane, owner, inputJson] = rest.slice(1);
    const input = JSON.parse(inputJson!) as SourceInput;
    db.exec("BEGIN IMMEDIATE");
    db.query("INSERT OR IGNORE INTO route_owners(route_binding, plane) VALUES (?, ?)").run(input.routeBinding, owner!);
    const actualOwner = (db.query("SELECT plane FROM route_owners WHERE route_binding = ?").get(input.routeBinding) as { plane: string }).plane;
    db.exec("COMMIT");
    if (plane !== actualOwner) {
      event(db, role, "dual-plane-write-rejected-by-owner", null, { plane, actualOwner });
      emit({ pid: process.pid, rejected: true, actualOwner });
    } else {
      emit({ pid: process.pid, rejected: false, delivery: enqueue(db, role, input) });
    }
  }
  db.close();
}

async function startDaemon(path: string): Promise<{
  pid: number;
  request(command: Command): Promise<any>;
  exited: Promise<number>;
}> {
  const child = Bun.spawn([process.execPath, scriptPath, "--daemon", path], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  async function readLine(): Promise<string> {
    while (!buffered.includes("\n")) {
      const next = await reader.read();
      if (next.done) throw new Error(`daemon ${child.pid} exited before acknowledgement`);
      buffered += decoder.decode(next.value, { stream: true });
    }
    const newline = buffered.indexOf("\n");
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    return line;
  }

  const ready = JSON.parse(await readLine());
  return {
    pid: ready.pid,
    exited: child.exited,
    async request(command: Command): Promise<any> {
      child.stdin.write(`${JSON.stringify(command)}\n`);
      child.stdin.flush();
      return JSON.parse(await readLine());
    },
  };
}

async function runDaemon(path: string): Promise<void> {
  const db = openDb(path);
  db.exec("BEGIN IMMEDIATE");
  db.query("INSERT OR REPLACE INTO metadata(key, value) VALUES ('database-owner-role', 'central-gateway-daemon')").run();
  db.query("INSERT OR REPLACE INTO metadata(key, value) VALUES ('migration-owner-role', 'central-gateway-daemon')").run();
  db.query("INSERT OR REPLACE INTO metadata(key, value) VALUES ('checkpoint-owner-role', 'central-gateway-daemon')").run();
  db.query("INSERT OR REPLACE INTO metadata(key, value) VALUES ('discovery-owner-role', 'central-gateway-daemon')").run();
  db.query("INSERT OR REPLACE INTO metadata(key, value) VALUES ('queue-owner-role', 'central-gateway-daemon')").run();
  event(db, "central-gateway-daemon", "daemon-ready", null, {
    database: realpathSync(path),
    lifecycle: ["database", "migrations", "checkpoint", "discovery", "queue"],
    supervisorPid: process.ppid,
  });
  db.exec("COMMIT");
  emit({ pid: process.pid, ready: true });

  for await (const line of console) {
    const command = JSON.parse(line) as Command;
    if (command.op === "enqueue") {
      emit({ pid: process.pid, delivery: enqueue(db, "central-gateway-daemon", command.input, command.crash) });
    } else if (command.op === "record-submission") {
      emit({
        pid: process.pid,
        delivery: recordSubmission(
          db,
          "central-gateway-daemon",
          command.deliveryId,
          command.receipt,
          command.crash,
        ),
      });
    } else if (command.op === "record-observation") {
      emit({ pid: process.pid, delivery: recordObservation(db, "central-gateway-daemon", command.deliveryId) });
    } else if (command.op === "checkpoint") {
      const checkpoint = db.query("PRAGMA wal_checkpoint(PASSIVE)").get();
      event(db, "central-gateway-daemon", "owned-passive-checkpoint", null, checkpoint);
      emit({ pid: process.pid, checkpoint });
    } else if (command.op === "state") {
      emit({ pid: process.pid, deliveries: db.query("SELECT * FROM deliveries ORDER BY id").all() });
    } else if (command.op === "shutdown") {
      event(db, "central-gateway-daemon", "graceful-prototype-shutdown", null, {});
      emit({ pid: process.pid, stopped: true });
      db.close();
      return;
    }
  }
  db.close();
}

function source(repository: string, sourceId: string, route: string, payload: string): { pid: number; input: SourceInput } {
  return worker(["source", "unused", repository, sourceId, route, payload]).result;
}

function printScenario(name: string, path: string, observations: unknown): void {
  console.log(`\nSCENARIO ${name}`);
  console.log(JSON.stringify({ observations, fullState: state(path) }, null, 2));
}

async function runCentral(path: string): Promise<ScenarioResult> {
  let daemon = await startDaemon(path);
  const daemonPids = [daemon.pid];
  const restart = async (): Promise<void> => {
    daemon = await startDaemon(path);
    daemonPids.push(daemon.pid);
  };

  const firstSource = source("repo-alpha", "source-cross-process", "route-main", "hello-model");
  const firstEnqueue = await daemon.request({ op: "enqueue", input: firstSource.input });
  const harnessProbe = worker(["harness-probe", path, "central"]);
  await daemon.request({
    op: "record-submission",
    deliveryId: harnessProbe.result.candidate.id,
    receipt: harnessProbe.result.receipt,
  });
  const modelBefore = worker(["model-read", path, "central"]);
  const observerProbe = worker(["observer-probe", path, "central"]);
  await daemon.request({ op: "record-observation", deliveryId: observerProbe.result.submitted.id });
  const modelAfter = worker(["model-read", path, "central"]);
  printScenario("central/cross-process-chain-and-receipt-separation", path, {
    pids: {
      source: firstSource.pid,
      daemon: firstEnqueue.pid,
      harness: harnessProbe.pid,
      observer: observerProbe.pid,
      modelReader: modelAfter.pid,
    },
    modelBeforeReceiptObservation: modelBefore.result.visible.map((d: Delivery) => d.id),
    modelAfterSeparateObservation: modelAfter.result.visible.map((d: Delivery) => d.id),
  });

  const offlineSource = source("repo-alpha", "source-offline", "route-offline", "queued-while-offline");
  const offlineDelivery = (await daemon.request({ op: "enqueue", input: offlineSource.input })).delivery as Delivery;
  const offline = worker(["harness-offline", path, "central"]);
  const wake = worker(["harness-probe", path, "central"]);
  await daemon.request({ op: "record-submission", deliveryId: wake.result.candidate.id, receipt: wake.result.receipt });
  const wakeObserver = worker(["observer-probe", path, "central"]);
  await daemon.request({ op: "record-observation", deliveryId: wakeObserver.result.submitted.id });
  printScenario("central/offline-wake-reconnect-replay", path, {
    offlineSawDurableCandidate: offline.result.candidate.id,
    replayedAfterWake: wake.result.candidate.id,
    finalState: state(path).deliveries.find((d) => d.id === offlineDelivery.id)?.state,
  });

  const a1 = source("repo-alpha", "route-a-1", "route-a", "A1");
  const a2 = source("repo-alpha", "route-a-2", "route-a", "A2");
  const b1 = source("repo-alpha", "route-b-1", "route-b", "B1");
  const a1d = (await daemon.request({ op: "enqueue", input: a1.input })).delivery as Delivery;
  const a2d = (await daemon.request({ op: "enqueue", input: a2.input })).delivery as Delivery;
  const b1d = (await daemon.request({ op: "enqueue", input: b1.input })).delivery as Delivery;
  const pickA1 = worker(["harness-probe", path, "central"]);
  await daemon.request({ op: "record-submission", deliveryId: pickA1.result.candidate.id, receipt: pickA1.result.receipt });
  const pickWhileABlocked = worker(["harness-probe", path, "central"]);
  await daemon.request({
    op: "record-submission",
    deliveryId: pickWhileABlocked.result.candidate.id,
    receipt: pickWhileABlocked.result.receipt,
  });
  await daemon.request({ op: "record-observation", deliveryId: b1d.id });
  await daemon.request({ op: "record-observation", deliveryId: a1d.id });
  const pickA2 = worker(["harness-probe", path, "central"]);
  await daemon.request({ op: "record-submission", deliveryId: pickA2.result.candidate.id, receipt: pickA2.result.receipt });
  await daemon.request({ op: "record-observation", deliveryId: a2d.id });
  printScenario("central/per-route-ordering-with-independent-route", path, {
    first: pickA1.result.candidate.id,
    whileRouteABlocked: pickWhileABlocked.result.candidate.id,
    afterA1Visible: pickA2.result.candidate.id,
    expected: { first: a1d.id, independent: b1d.id, then: a2d.id },
  });

  const idem = source("repo-alpha", "source-idempotent", "route-idem", "same");
  const original = (await daemon.request({ op: "enqueue", input: idem.input })).delivery as Delivery;
  const retry = (await daemon.request({ op: "enqueue", input: idem.input })).delivery as Delivery;
  const otherRepo = source("repo-beta", "source-idempotent", "route-idem-other", "same-source-different-repo");
  const otherDelivery = (await daemon.request({ op: "enqueue", input: otherRepo.input })).delivery as Delivery;

  const before = source("repo-alpha", "crash-before", "route-crash-before", "before");
  let beforeExit = -1;
  try {
    await daemon.request({ op: "enqueue", input: before.input, crash: "before-commit" });
  } catch {
    beforeExit = await daemon.exited;
  }
  const absentBeforeRetry = !state(path).deliveries.some((d) => d.source_id === "crash-before");
  await restart();
  const beforeRetry = (await daemon.request({ op: "enqueue", input: before.input })).delivery as Delivery;

  const ambiguous = source("repo-alpha", "crash-after-commit", "route-crash-commit", "ambiguous");
  let afterCommitExit = -1;
  try {
    await daemon.request({ op: "enqueue", input: ambiguous.input, crash: "after-commit-before-ack" });
  } catch {
    afterCommitExit = await daemon.exited;
  }
  const committedDuringAmbiguity = state(path).deliveries.find((d) => d.source_id === "crash-after-commit")!;
  await restart();
  const ambiguousRetry = (await daemon.request({ op: "enqueue", input: ambiguous.input })).delivery as Delivery;

  const submittedCrashSource = source("repo-alpha", "crash-after-submit", "route-crash-submit", "submitted");
  const submittedCrashDelivery = (await daemon.request({ op: "enqueue", input: submittedCrashSource.input })).delivery as Delivery;
  const crashHarness = worker(["harness-probe-id", path, "central", submittedCrashDelivery.id]);
  let afterSubmitExit = -1;
  try {
    await daemon.request({
      op: "record-submission",
      deliveryId: crashHarness.result.candidate.id,
      receipt: crashHarness.result.receipt,
      crash: "after-submit-before-observation",
    });
  } catch {
    afterSubmitExit = await daemon.exited;
  }
  const invisibleAfterSubmit = !worker(["model-read", path, "central"]).result.visible.some(
    (d: Delivery) => d.id === submittedCrashDelivery.id,
  );
  await restart();
  const recoveryObserver = worker(["observer-probe", path, "central"]);
  await daemon.request({ op: "record-observation", deliveryId: recoveryObserver.result.submitted.id });
  const visibleAfterRecovery = worker(["model-read", path, "central"]);
  await daemon.request({ op: "checkpoint" });
  printScenario("central/idempotency-crash-windows-and-supervised-restart", path, {
    repositoryIdempotency: { original: original.id, retry: retry.id, otherRepository: otherDelivery.id },
    beforeCommit: { exitCode: beforeExit, absentBeforeRetry, retryDelivery: beforeRetry.id },
    afterCommitBeforeAck: {
      exitCode: afterCommitExit,
      committedDelivery: committedDuringAmbiguity.id,
      retryDelivery: ambiguousRetry.id,
    },
    afterSubmissionBeforeObservation: {
      exitCode: afterSubmitExit,
      invisibleAfterSubmit,
      visibleAfterRestart: visibleAfterRecovery.result.visible.some((d: Delivery) => d.id === submittedCrashDelivery.id),
    },
    daemonPids,
  });

  const observedSqliteWriterRoles = Array.from(new Set(state(path).events.map((row) => String(row.role))));
  const result: ScenarioResult = {
    topology: "central",
    observedSqliteWriterRoles,
    processChain: {
      source: firstSource.pid,
      enqueue: firstEnqueue.pid,
      harness: harnessProbe.pid,
      observer: observerProbe.pid,
      modelReader: modelAfter.pid,
    },
    crossProcessVisible: modelAfter.result.visible.some((d: Delivery) => d.id === firstEnqueue.delivery.id),
    receiptWasNotVisibility: !modelBefore.result.visible.some((d: Delivery) => d.id === firstEnqueue.delivery.id),
    offlineReplay: state(path).deliveries.find((d) => d.id === offlineDelivery.id)?.state === "visible",
    strictRouteOrdering: pickA1.result.candidate.id === a1d.id && pickA2.result.candidate.id === a2d.id,
    unrelatedRouteProgress: pickWhileABlocked.result.candidate.id === b1d.id,
    repositoryScopedIdempotency: original.id === retry.id && original.id !== otherDelivery.id,
    beforeCommitRecoveredByRetry: absentBeforeRetry && beforeRetry.source_id === "crash-before",
    afterCommitRetryReturnedOriginal: committedDuringAmbiguity.id === ambiguousRetry.id,
    submittedBeforeObservationRecovered:
      invisibleAfterSubmit && visibleAfterRecovery.result.visible.some((d: Delivery) => d.id === submittedCrashDelivery.id),
    processRestartRecovered: new Set(daemonPids).size === daemonPids.length && daemonPids.length === 4,
    failureIsolation: "Observed daemon crashes stopped the write plane until the supervisor restarted it; persisted WAL state then recovered.",
    lifecycleOwnership: "Observed one active gateway-daemon role own database, migration, checkpoint, discovery, and queue mutations.",
    operationalRequirements: [
      "singleton/supervisor",
      "client reconnect and ambiguous-result retry",
      "graceful drain and signal ownership",
      "canonical database discovery",
      "event-loop latency budget for synchronous SQLite",
    ],
    crashEvidence: {
      beforeCommit: { exitCode: beforeExit, absentBeforeRetry },
      afterCommitBeforeAck: { exitCode: afterCommitExit, sameDelivery: committedDuringAmbiguity.id === ambiguousRetry.id },
      afterSubmitBeforeObservation: { exitCode: afterSubmitExit, invisibleAfterSubmit },
    },
  };
  await daemon.request({ op: "shutdown" });
  await daemon.exited;
  return result;
}

async function runFederated(path: string): Promise<ScenarioResult> {
  const firstSource = source("repo-alpha", "source-cross-process", "route-main", "hello-model");
  const firstEnqueue = worker(["enqueue", path, "federated", JSON.stringify(firstSource.input)]);
  const firstHarness = worker(["harness-submit", path, "federated"]);
  const modelBefore = worker(["model-read", path, "federated"]);
  const firstObserver = worker(["observer-record", path, "federated", firstHarness.result.delivery.id]);
  const modelAfter = worker(["model-read", path, "federated"]);
  printScenario("federated/cross-process-chain-and-receipt-separation", path, {
    pids: {
      source: firstSource.pid,
      enqueue: firstEnqueue.pid,
      harness: firstHarness.pid,
      observer: firstObserver.pid,
      modelReader: modelAfter.pid,
    },
    modelBeforeReceiptObservation: modelBefore.result.visible.map((d: Delivery) => d.id),
    modelAfterSeparateObservation: modelAfter.result.visible.map((d: Delivery) => d.id),
  });

  const offlineSource = source("repo-alpha", "source-offline", "route-offline", "queued-while-offline");
  const offlineDelivery = worker(["enqueue", path, "federated", JSON.stringify(offlineSource.input)]).result.delivery as Delivery;
  const offline = worker(["harness-offline", path, "federated"]);
  const wake = worker(["harness-submit", path, "federated"]);
  worker(["observer-record", path, "federated", wake.result.delivery.id]);
  printScenario("federated/offline-wake-reconnect-replay", path, {
    offlineSawDurableCandidate: offline.result.candidate.id,
    replayedAfterWake: wake.result.delivery.id,
    finalState: state(path).deliveries.find((d) => d.id === offlineDelivery.id)?.state,
  });

  const a1 = source("repo-alpha", "route-a-1", "route-a", "A1");
  const a2 = source("repo-alpha", "route-a-2", "route-a", "A2");
  const b1 = source("repo-alpha", "route-b-1", "route-b", "B1");
  const a1d = worker(["enqueue", path, "federated", JSON.stringify(a1.input)]).result.delivery as Delivery;
  const a2d = worker(["enqueue", path, "federated", JSON.stringify(a2.input)]).result.delivery as Delivery;
  const b1d = worker(["enqueue", path, "federated", JSON.stringify(b1.input)]).result.delivery as Delivery;
  const pickA1 = worker(["harness-submit", path, "federated"]);
  const pickWhileABlocked = worker(["harness-submit", path, "federated"]);
  worker(["observer-record", path, "federated", b1d.id]);
  worker(["observer-record", path, "federated", a1d.id]);
  const pickA2 = worker(["harness-submit", path, "federated"]);
  worker(["observer-record", path, "federated", a2d.id]);
  printScenario("federated/per-route-ordering-with-independent-route", path, {
    first: pickA1.result.delivery.id,
    whileRouteABlocked: pickWhileABlocked.result.delivery.id,
    afterA1Visible: pickA2.result.delivery.id,
    expected: { first: a1d.id, independent: b1d.id, then: a2d.id },
  });

  const idem = source("repo-alpha", "source-idempotent", "route-idem", "same");
  const original = worker(["enqueue", path, "federated", JSON.stringify(idem.input)]).result.delivery as Delivery;
  const retry = worker(["enqueue", path, "federated", JSON.stringify(idem.input)]).result.delivery as Delivery;
  const otherRepo = source("repo-beta", "source-idempotent", "route-idem-other", "same-source-different-repo");
  const otherDelivery = worker(["enqueue", path, "federated", JSON.stringify(otherRepo.input)]).result.delivery as Delivery;

  const before = source("repo-alpha", "crash-before", "route-crash-before", "before");
  const beforeCrash = worker(
    ["enqueue", path, "federated", JSON.stringify(before.input), "before-commit"],
    false,
  );
  const absentBeforeRetry = !state(path).deliveries.some((d) => d.source_id === "crash-before");
  const beforeRetry = worker(["enqueue", path, "federated", JSON.stringify(before.input)]).result.delivery as Delivery;

  const ambiguous = source("repo-alpha", "crash-after-commit", "route-crash-commit", "ambiguous");
  const afterCommitCrash = worker(
    ["enqueue", path, "federated", JSON.stringify(ambiguous.input), "after-commit-before-ack"],
    false,
  );
  const committedDuringAmbiguity = state(path).deliveries.find((d) => d.source_id === "crash-after-commit")!;
  const ambiguousRetry = worker(["enqueue", path, "federated", JSON.stringify(ambiguous.input)]).result.delivery as Delivery;

  const submittedCrashSource = source("repo-alpha", "crash-after-submit", "route-crash-submit", "submitted");
  const submittedCrashDelivery = worker([
    "enqueue",
    path,
    "federated",
    JSON.stringify(submittedCrashSource.input),
  ]).result.delivery as Delivery;
  const afterSubmitCrash = worker(
    ["harness-submit-id", path, "federated", submittedCrashDelivery.id, "after-submit-before-observation"],
    false,
  );
  const invisibleAfterSubmit = !worker(["model-read", path, "federated"]).result.visible.some(
    (d: Delivery) => d.id === submittedCrashDelivery.id,
  );
  const recoveryObserver = worker(["observer-record", path, "federated", submittedCrashDelivery.id]);
  const visibleAfterRecovery = worker(["model-read", path, "federated"]);

  const crashedRoute = source("repo-alpha", "isolation-crash", "route-isolation-a", "crash-a");
  const isolationCrash = worker(
    ["enqueue", path, "federated", JSON.stringify(crashedRoute.input), "before-commit"],
    false,
  );
  const unrelated = source("repo-alpha", "isolation-progress", "route-isolation-b", "progress-b");
  const unrelatedDelivery = worker(["enqueue", path, "federated", JSON.stringify(unrelated.input)]).result.delivery as Delivery;
  printScenario("federated/idempotency-crash-windows-and-writer-isolation", path, {
    repositoryIdempotency: { original: original.id, retry: retry.id, otherRepository: otherDelivery.id },
    beforeCommit: { exitCode: beforeCrash.exitCode, absentBeforeRetry, retryDelivery: beforeRetry.id },
    afterCommitBeforeAck: {
      exitCode: afterCommitCrash.exitCode,
      committedDelivery: committedDuringAmbiguity.id,
      retryDelivery: ambiguousRetry.id,
    },
    afterSubmissionBeforeObservation: {
      exitCode: afterSubmitCrash.exitCode,
      invisibleAfterSubmit,
      observerRestartPid: recoveryObserver.pid,
      visibleAfterRestart: visibleAfterRecovery.result.visible.some((d: Delivery) => d.id === submittedCrashDelivery.id),
    },
    failureIsolation: {
      crashedWriterExit: isolationCrash.exitCode,
      unrelatedWriterStillCommitted: unrelatedDelivery.id,
    },
  });

  const crashedWriterPid = Number(
    (
      state(path).events.find(
        (row) => row.action === "crash-window-before-delivery-commit" && String(row.detail).includes("isolation-crash"),
      ) as { actor_pid: number }
    ).actor_pid,
  );
  const afterSubmitWriterPid = Number(
    (
      state(path).events.find(
        (row) => row.action === "harness-submission-receipt" && row.delivery_id === submittedCrashDelivery.id,
      ) as { actor_pid: number }
    ).actor_pid,
  );
  const distinctChain = new Set([
    firstSource.pid,
    firstEnqueue.pid,
    firstHarness.pid,
    firstObserver.pid,
    modelAfter.pid,
  ]).size === 5;
  return {
    topology: "federated",
    observedSqliteWriterRoles: Array.from(new Set(state(path).events.map((row) => String(row.role)))),
    processChain: {
      source: firstSource.pid,
      enqueue: firstEnqueue.pid,
      harness: firstHarness.pid,
      observer: firstObserver.pid,
      modelReader: modelAfter.pid,
    },
    crossProcessVisible: distinctChain && modelAfter.result.visible.some((d: Delivery) => d.id === firstEnqueue.result.delivery.id),
    receiptWasNotVisibility: !modelBefore.result.visible.some((d: Delivery) => d.id === firstEnqueue.result.delivery.id),
    offlineReplay: state(path).deliveries.find((d) => d.id === offlineDelivery.id)?.state === "visible",
    strictRouteOrdering: pickA1.result.delivery.id === a1d.id && pickA2.result.delivery.id === a2d.id,
    unrelatedRouteProgress: pickWhileABlocked.result.delivery.id === b1d.id,
    repositoryScopedIdempotency: original.id === retry.id && original.id !== otherDelivery.id,
    beforeCommitRecoveredByRetry: absentBeforeRetry && beforeRetry.source_id === "crash-before",
    afterCommitRetryReturnedOriginal: committedDuringAmbiguity.id === ambiguousRetry.id,
    submittedBeforeObservationRecovered:
      invisibleAfterSubmit && visibleAfterRecovery.result.visible.some((d: Delivery) => d.id === submittedCrashDelivery.id),
    processRestartRecovered: recoveryObserver.pid !== afterSubmitWriterPid,
    failureIsolation: `Observed writer PID ${crashedWriterPid} exit while unrelated writer committed ${unrelatedDelivery.id}.`,
    lifecycleOwnership: "Observed every source/harness/observer writer open the database and report migration, checkpoint-policy, and discovery ownership.",
    operationalRequirements: [
      "bounded busy/fairness policy across writers",
      "compatible migration gate across binaries",
      "checkpoint leader or WAL growth monitoring",
      "canonical database discovery in every launcher",
      "per-process reconnect and crash recovery",
    ],
    crashEvidence: {
      beforeCommit: { exitCode: beforeCrash.exitCode, absentBeforeRetry },
      afterCommitBeforeAck: { exitCode: afterCommitCrash.exitCode, sameDelivery: committedDuringAmbiguity.id === ambiguousRetry.id },
      afterSubmitBeforeObservation: { exitCode: afterSubmitCrash.exitCode, invisibleAfterSubmit },
      isolatedWriter: { exitCode: isolationCrash.exitCode, unrelatedCommitted: unrelatedDelivery.id },
    },
  };
}

function runDualPlane(path: string): Record<string, unknown> {
  const legacyDuplicate = worker([
    "dual-unruled",
    path,
    "dual",
    "legacy",
    "repo-alpha",
    "same-upstream-event",
    "route-dual",
    "1",
    "legacy-copy",
  ]);
  const gatewayDuplicate = worker([
    "dual-unruled",
    path,
    "dual",
    "gateway",
    "repo-alpha",
    "same-upstream-event",
    "route-dual",
    "1",
    "gateway-copy",
  ]);
  worker([
    "dual-unruled",
    path,
    "dual",
    "gateway",
    "repo-alpha",
    "ordered-2",
    "route-cross-plane-order",
    "2",
    "gateway-seq-2",
  ]);
  worker([
    "dual-unruled",
    path,
    "dual",
    "legacy",
    "repo-alpha",
    "ordered-1",
    "route-cross-plane-order",
    "1",
    "legacy-seq-1",
  ]);

  const sharedSource = source("repo-alpha", "shared-upstream-event", "route-owned", "shared");
  const gatewayOwned = worker([
    "dual-shared",
    path,
    "dual",
    "gateway",
    "gateway",
    JSON.stringify(sharedSource.input),
  ]);
  const legacyRejected = worker([
    "dual-shared",
    path,
    "dual",
    "legacy",
    "gateway",
    JSON.stringify(sharedSource.input),
  ]);
  const db = openDb(path, false);
  const unruled = db.query("SELECT * FROM dual_deliveries ORDER BY rowid").all() as Record<string, unknown>[];
  const duplicateCount = Number(
    (
      db
        .query("SELECT count(*) AS count FROM dual_deliveries WHERE repository = 'repo-alpha' AND source_id = 'same-upstream-event'")
        .get() as { count: number }
    ).count,
  );
  const arrivalOrder = (
    db.query("SELECT route_seq FROM dual_deliveries WHERE route_binding = 'route-cross-plane-order' ORDER BY rowid").all() as {
      route_seq: number;
    }[]
  ).map((row) => row.route_seq);
  db.close();
  const result = {
    boundedProbeNotEndState: true,
    withoutSharedRule: {
      writerPids: [legacyDuplicate.pid, gatewayDuplicate.pid],
      duplicateCount,
      arrivalOrder,
      duplicateObserved: duplicateCount === 2,
      orderInversionObserved: arrivalOrder.join(",") === "2,1",
    },
    withSharedIdempotencyAndOwnershipRule: {
      gatewayDelivery: gatewayOwned.result.delivery.id,
      legacyRejected: legacyRejected.result.rejected,
      owner: legacyRejected.result.actualOwner,
      oneDeliveryObserved: state(path).deliveries.filter((d) => d.source_id === "shared-upstream-event").length === 1,
    },
    allDualRows: unruled,
  };
  printScenario("dual-plane/bounded-overlap-with-and-without-shared-rule", path, result);
  return result;
}

function checkRows(result: ScenarioResult): Record<string, boolean> {
  return {
    "OS-process source-to-model chain": new Set(Object.values(result.processChain)).size === 5,
    "durable offline replay": result.offlineReplay,
    "receipt is not model visibility": result.receiptWasNotVisibility,
    "strict per-Route-Binding ordering": result.strictRouteOrdering,
    "unrelated Route Binding progresses": result.unrelatedRouteProgress,
    "repository-scoped source idempotency": result.repositoryScopedIdempotency,
    "before-commit retry recovery": result.beforeCommitRecoveredByRetry,
    "after-commit ambiguous retry original": result.afterCommitRetryReturnedOriginal,
    "submitted/unobserved restart recovery": result.submittedBeforeObservationRecovered,
  };
}

function printMatrix(central: ScenarioResult, federated: ScenarioResult, dual: Record<string, any>): void {
  const centralChecks = checkRows(central);
  const federatedChecks = checkRows(federated);
  console.log("\nHUMAN-READABLE OBSERVED COMPARISON MATRIX");
  console.log("| Observed check | Central single writer | Federated N writers |");
  console.log("|---|---|---|");
  for (const name of Object.keys(centralChecks)) {
    console.log(`| ${name} | ${centralChecks[name] ? "PASS" : "FAIL"} | ${federatedChecks[name] ? "PASS" : "FAIL"} |`);
  }
  console.log(`| Lifecycle ownership | ${central.lifecycleOwnership} | ${federated.lifecycleOwnership} |`);
  console.log(
    `| Observed SQLite writer roles | ${central.observedSqliteWriterRoles.join(", ")} | ${federated.observedSqliteWriterRoles.join(", ")} |`,
  );
  console.log(`| Failure isolation | ${central.failureIsolation} | ${federated.failureIsolation} |`);
  console.log(
    `| Dual-plane overlap | Not an end state; without a shared rule duplicates=${dual.withoutSharedRule.duplicateCount}, arrival=${dual.withoutSharedRule.arrivalOrder.join("->")} | Shared rule admitted one owner/delivery=${dual.withSharedIdempotencyAndOwnershipRule.oneDeliveryObserved} |`,
  );
}

async function main(): Promise<void> {
  console.log(`Exact question: ${QUESTION}`);
  console.log(`Assumption: ${ASSUMPTION}`);
  console.log(
    "Durability boundary: this scratch tracer uses WAL + synchronous=FULL. Process exits test application-process recovery while the OS remains alive; they are not proof of host/power-loss survival or storage sync honesty.",
  );
  const root = mkdtempSync(join(tmpdir(), "octo-santa-PROTOTYPE-WIPE-process-topologies-"));
  const centralPath = join(root, "PROTOTYPE-WIPE-central.sqlite");
  const federatedPath = join(root, "PROTOTYPE-WIPE-federated.sqlite");
  const dualPath = join(root, "PROTOTYPE-WIPE-dual-plane.sqlite");
  console.log(`Scratch directory: ${root}`);

  const central = await runCentral(centralPath);
  const federated = await runFederated(federatedPath);
  const dual = runDualPlane(dualPath);
  printMatrix(central, federated, dual);

  const allPass = Object.values(checkRows(central)).every(Boolean) && Object.values(checkRows(federated)).every(Boolean);
  const recommendation = allPass
    ? "Evidence supports a central single-writer daemon as the end state because it preserves the delivery invariants while concentrating lifecycle ownership. Keep current MCP processes during migration through a narrow compatibility/anti-corruption adapter that sends one owned mutation to the daemon; do not dual-write."
    : "Evidence does not support selecting an end state because one or more required delivery checks failed.";
  const summary = {
    question: QUESTION,
    assumption: ASSUMPTION,
    scratchDirectory: root,
    durability: {
      journalMode: "WAL",
      synchronous: "FULL",
      established: "committed rows recovered after prototype process exits/restarts while the OS remained alive",
      notEstablished: "host failure, kernel failure, power loss, filesystem/device sync honesty, production latency",
    },
    central,
    federated,
    dualPlane: dual,
    recommendation,
    migrationPosture:
      "Coexist with current MCP OS processes without production schema/import/wiring changes. Introduce daemon discovery plus one compatibility/anti-corruption adapter, move one mutation owner at a time, retry ambiguous requests by repository/source ID, then remove the legacy write path before the next owner moves.",
    northStarInvariants: {
      survive: [
        "SQLite durability remains the delivery source of truth before acknowledgement.",
        "Push/submission is best-effort and never substitutes for model-visible observation/poll fallback.",
        "Cross-process behavior is verified with separate OS processes and shared SQLite state.",
        "Repository-scoped source retries return the original Delivery.",
        "Ordering is strict within each Route Binding, not globally across unrelated bindings.",
      ],
      supersededForCentralEndState: [
        "Every MCP composition root migrates and owns write/checkpoint policy.",
        "Every source/harness process writes SQLite directly.",
        "Transport close implicitly owns database lifecycle; the daemon needs explicit supervision, drain, reconnect, and signal ownership.",
      ],
    },
    limitations: [
      "Deterministic fake source, fake harness, and file-local scratch databases only; no production imports/schema/wiring or MCP protocol migration.",
      "No load, throughput, busy fairness, checkpoint growth, long-reader, backup, mixed-schema, or target-hardware latency measurement.",
      "FULL requests per-commit WAL sync but does not prove the filesystem/device honors sync under actual power loss.",
      "Central synchronous SQLite event-loop head-of-line blocking is an operational risk from primary evidence, not measured by this tracer.",
      "BEGIN EXCLUSIVE reader behavior is not used as a maintenance gate; migration compatibility remains unresolved.",
      "The dual-plane probe is deliberately bounded evidence of duplicate/order hazards, not a recommended steady state.",
    ],
    failedOrInconclusive: allPass
      ? [
          "No required deterministic scenario failed.",
          "Power-loss durability, production performance, busy fairness, migration rollout, backup, and daemon signal/drain behavior remain inconclusive.",
        ]
      : Object.entries({ central: checkRows(central), federated: checkRows(federated) })
          .flatMap(([topology, checks]) => Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => `${topology}: ${name}`)),
  };
  console.log(`\nRECOMMENDATION\n${recommendation}`);
  console.log(`\nMACHINE_SUMMARY_JSON=${JSON.stringify(summary)}`);
  writeFileSync(join(root, "PROTOTYPE-WIPE-machine-summary.json"), JSON.stringify(summary, null, 2));
}

if (process.argv[2] === "--worker") {
  runWorkerMode(process.argv.slice(3));
} else if (process.argv[2] === "--daemon") {
  await runDaemon(process.argv[3]!);
} else {
  await main();
}
