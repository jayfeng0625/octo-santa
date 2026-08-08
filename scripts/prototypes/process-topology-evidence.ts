/**
 * PROTOTYPE/WIPE: disposable process-topology evidence for GitHub issue #38.
 *
 * This intentionally does not select an architecture. It compares one persistent
 * SQLite-opening gateway process with N persistent SQLite-opening worker processes,
 * then records the remaining judgments separately from observations.
 *
 * Run: bun scripts/prototypes/process-topology-evidence.ts
 */

import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

type Topology = "central" | "federated";
type SyncMode = "NORMAL" | "FULL";

type Request =
  | {
      id: string;
      op: "write";
      sourceId: string;
      clientId: string;
      sequence: number;
      holdMs: number;
      crashAfterCommit?: boolean;
    }
  | { id: string; op: "ping" }
  | { id: string; op: "checkpoint" }
  | { id: string; op: "shutdown" };

type WriteResponse = {
  id: string;
  ok: true;
  op: "write";
  pid: number;
  existing: boolean;
  acquisitionMs: number;
  transactionMs: number;
  busyRetries: number;
};

type Response =
  | WriteResponse
  | { id: string; ok: true; op: "ping"; pid: number; at: number }
  | { id: string; ok: true; op: "checkpoint"; pid: number; result: unknown }
  | { id: string; ok: true; op: "shutdown"; pid: number }
  | { id: string; ok: false; error: string; pid: number };

type Progress = { type: "transaction-started"; id: string; pid: number };

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
type RequestInput = WithoutId<Request>;

type Sample = {
  clientId: string;
  sequence: number;
  latencyMs: number;
  acquisitionMs: number;
  transactionMs: number;
  busyRetries: number;
  writerPid: number;
};

type WorkerHandle = {
  pid: number;
  exited: Promise<number>;
  request(request: RequestInput, onTransactionStarted?: () => void): Promise<Response>;
};

const scriptPath = realpathSync(import.meta.path);
let requestNumber = 0;
const liveWorkers = new Set<WorkerHandle>();

function isBusy(error: unknown): boolean {
  return error instanceof Error && /locked|sqlite_busy/i.test(error.message);
}

function withBusyRetry<T>(operation: () => T): { value: T; retries: number } {
  let retries = 0;
  for (;;) {
    try {
      return { value: operation(), retries };
    } catch (error) {
      if (!isBusy(error) || retries === 3) throw error;
      retries += 1;
      Bun.sleepSync(10 * retries);
    }
  }
}

function configureDb(db: Database, synchronous: SyncMode): void {
  db.run("PRAGMA busy_timeout = 5000");
  withBusyRetry(() => db.run("PRAGMA journal_mode = WAL"));
  db.run(`PRAGMA synchronous = ${synchronous}`);
  db.run("PRAGMA foreign_keys = ON");
}

function ensureSchema(db: Database): void {
  withBusyRetry(() =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS deliveries (
        source_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        payload TEXT NOT NULL,
        committed_by_pid INTEGER NOT NULL,
        committed_at_ms REAL NOT NULL,
        UNIQUE (client_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS connection_audit (
        pid INTEGER NOT NULL,
        topology TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        opened_at_ms REAL NOT NULL,
        PRIMARY KEY (pid, worker_id)
      );
    `),
  );
}

function openWorkerDb(
  path: string,
  synchronous: SyncMode,
  topology: Topology,
  workerId: string,
): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  configureDb(db, synchronous);
  ensureSchema(db);
  withBusyRetry(() =>
    db
      .query(
        "INSERT INTO connection_audit(pid, topology, worker_id, opened_at_ms) VALUES (?, ?, ?, ?)",
      )
      .run(process.pid, topology, workerId, performance.timeOrigin + performance.now()),
  );
  return db;
}

function rollbackIfNeeded(db: Database): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // The failed operation may not have acquired a transaction.
  }
}

function writeDelivery(
  db: Database,
  request: Extract<Request, { op: "write" }>,
  onTransactionStarted: () => void,
): WriteResponse {
  const transactionStart = performance.now();
  let acquisitionMs = 0;
  const { value: existing, retries } = withBusyRetry(() => {
    const acquisitionStart = performance.now();
    try {
      db.exec("BEGIN IMMEDIATE");
      acquisitionMs = performance.now() - acquisitionStart;
      const found = db
        .query("SELECT source_id FROM deliveries WHERE source_id = ?")
        .get(request.sourceId) as { source_id: string } | null;
      if (!found) {
        db
          .query(
            `INSERT INTO deliveries(
               source_id, client_id, sequence, payload, committed_by_pid, committed_at_ms
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            request.sourceId,
            request.clientId,
            request.sequence,
            `payload-${request.sourceId}`,
            process.pid,
            performance.timeOrigin + performance.now(),
          );
      }
      onTransactionStarted();
      if (!found && request.holdMs > 0) Bun.sleepSync(request.holdMs);
      db.exec("COMMIT");
      return Boolean(found);
    } catch (error) {
      rollbackIfNeeded(db);
      throw error;
    }
  });

  if (request.crashAfterCommit) process.kill(process.pid, "SIGKILL");

  return {
    id: request.id,
    ok: true,
    op: "write",
    pid: process.pid,
    existing,
    acquisitionMs,
    transactionMs: performance.now() - transactionStart,
    busyRetries: retries,
  };
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function runWorker(args: string[]): Promise<void> {
  const [topology, workerId, dbPath, synchronous] = args as [
    Topology,
    string,
    string,
    SyncMode,
  ];
  const db = openWorkerDb(dbPath, synchronous, topology, workerId);
  emit({ type: "ready", pid: process.pid, topology, workerId, dbPath: db.filename });

  for await (const line of console) {
    const request = JSON.parse(line) as Request;
    try {
      if (request.op === "write") {
        emit(
          writeDelivery(db, request, () =>
            emit({ type: "transaction-started", id: request.id, pid: process.pid } satisfies Progress),
          ),
        );
      } else if (request.op === "ping") {
        emit({
          id: request.id,
          ok: true,
          op: "ping",
          pid: process.pid,
          at: performance.timeOrigin + performance.now(),
        } satisfies Response);
      } else if (request.op === "checkpoint") {
        emit({
          id: request.id,
          ok: true,
          op: "checkpoint",
          pid: process.pid,
          result: db.query("PRAGMA wal_checkpoint(PASSIVE)").get(),
        } satisfies Response);
      } else {
        emit({ id: request.id, ok: true, op: "shutdown", pid: process.pid } satisfies Response);
        db.close();
        return;
      }
    } catch (error) {
      emit({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        pid: process.pid,
      } satisfies Response);
    }
  }
  db.close();
}

async function startWorker(
  topology: Topology,
  workerId: string,
  dbPath: string,
  synchronous: SyncMode,
  cwd?: string,
): Promise<WorkerHandle> {
  const child = Bun.spawn(
    [process.execPath, scriptPath, "--worker", topology, workerId, dbPath, synchronous],
    { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const pending = new Map<
    string,
    {
      resolve: (response: Response) => void;
      reject: (error: Error) => void;
      onTransactionStarted?: () => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  let readyResolve!: (pid: number) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<number>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const readyTimeout = setTimeout(() => {
    child.kill("SIGKILL");
    readyReject(new Error(`worker ${topology}/${workerId} did not become ready`));
  }, 15_000);

  const rejectAll = (error: Error): void => {
    readyReject(error);
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    pending.clear();
  };

  void (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const message = JSON.parse(line) as Response | Progress | { type: "ready"; pid: number };
        if ("type" in message && message.type === "ready") {
          clearTimeout(readyTimeout);
          readyResolve(message.pid);
        } else if ("type" in message && message.type === "transaction-started") {
          pending.get(message.id)?.onTransactionStarted?.();
        } else if ("id" in message) {
          const waiter = pending.get(message.id);
          if (waiter) {
            pending.delete(message.id);
            clearTimeout(waiter.timeout);
            waiter.resolve(message);
          }
        }
      }
    }
  })().catch((error) => {
    child.kill("SIGKILL");
    rejectAll(error instanceof Error ? error : new Error(String(error)));
  });

  const exited = child.exited.then(async (code) => {
    clearTimeout(readyTimeout);
    const stderr = await new Response(child.stderr).text();
    const error = new Error(
      `worker ${topology}/${workerId} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
    );
    rejectAll(error);
    return code;
  });

  let pid: number;
  try {
    pid = await ready;
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  const handle: WorkerHandle = {
    pid,
    exited,
    request(request, onTransactionStarted) {
      const id = `request-${++requestNumber}`;
      return new Promise<Response>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          child.kill("SIGKILL");
          reject(new Error(`worker ${topology}/${workerId} timed out handling ${request.op}`));
        }, 15_000);
        pending.set(id, { resolve, reject, onTransactionStarted, timeout });
        try {
          child.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
          child.stdin.flush();
        } catch (error) {
          pending.delete(id);
          clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
  };
  liveWorkers.add(handle);
  void exited.then(() => liveWorkers.delete(handle));
  return handle;
}

async function stopWorkers(workers: WorkerHandle[]): Promise<void> {
  await Promise.all(
    workers.map(async (worker) => {
      try {
        await worker.request({ op: "shutdown" });
      } catch {
        return;
      }
      await worker.exited;
    }),
  );
}

async function startWorkerGroup(
  specs: Array<{
    topology: Topology;
    workerId: string;
    dbPath: string;
    synchronous: SyncMode;
    cwd?: string;
  }>,
): Promise<WorkerHandle[]> {
  const workers: WorkerHandle[] = [];
  try {
    for (const spec of specs) {
      workers.push(
        await startWorker(
          spec.topology,
          spec.workerId,
          spec.dbPath,
          spec.synchronous,
          spec.cwd,
        ),
      );
    }
    return workers;
  } catch (error) {
    await stopWorkers(workers);
    throw error;
  }
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return Number(sorted[index]!.toFixed(3));
}

function stats(values: number[]): Record<string, number> {
  return {
    min: percentile(values, 0),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: percentile(values, 1),
  };
}

function fileBytes(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

function inspectDb(path: string): {
  deliveryCount: number;
  connectionAudit: Record<string, unknown>[];
  integrityCheck: string;
} {
  const db = new Database(path, { readonly: true });
  const result = {
    deliveryCount: Number(
      (db.query("SELECT count(*) AS count FROM deliveries").get() as { count: number }).count,
    ),
    connectionAudit: db
      .query("SELECT pid, topology, worker_id, opened_at_ms FROM connection_audit ORDER BY opened_at_ms")
      .all() as Record<string, unknown>[],
    integrityCheck: String(
      (db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
    ),
  };
  db.close();
  return result;
}

async function runLoad(
  root: string,
  topology: Topology,
  synchronous: SyncMode,
  clientCount: number,
): Promise<Record<string, unknown>> {
  const writesPerClient = 8;
  const holdMs = 2;
  const dbPath = join(root, `${topology}-${synchronous}-${clientCount}.sqlite`);
  const initializer = new Database(dbPath, { create: true });
  configureDb(initializer, synchronous);
  ensureSchema(initializer);
  initializer.close();

  const workerCount = topology === "central" ? 1 : clientCount;
  const startupStart = performance.now();
  const workers = await startWorkerGroup(
    Array.from({ length: workerCount }, (_, index) => ({
      topology,
      workerId: `worker-${index}`,
      dbPath,
      synchronous,
    })),
  );
  const startupMs = performance.now() - startupStart;
  const samples: Sample[] = [];
  const workloadStart = performance.now();
  const clientDurations = await Promise.all(
    Array.from({ length: clientCount }, async (_, clientIndex) => {
      const clientId = `client-${clientIndex}`;
      const clientStart = performance.now();
      for (let sequence = 0; sequence < writesPerClient; sequence += 1) {
        const sentAt = performance.now();
        const response = await workers[topology === "central" ? 0 : clientIndex]!.request({
          op: "write",
          sourceId: `${topology}-${synchronous}-${clientCount}-${clientId}-${sequence}`,
          clientId,
          sequence,
          holdMs,
        });
        if (!response.ok || response.op !== "write") {
          throw new Error("load write failed");
        }
        samples.push({
          clientId,
          sequence,
          latencyMs: performance.now() - sentAt,
          acquisitionMs: response.acquisitionMs,
          transactionMs: response.transactionMs,
          busyRetries: response.busyRetries,
          writerPid: response.pid,
        });
      }
      return performance.now() - clientStart;
    }),
  );
  const wallMs = performance.now() - workloadStart;
  const walBeforeCheckpointBytes = fileBytes(`${dbPath}-wal`);
  const checkpointResponses = await Promise.all(
    workers.map((worker) => worker.request({ op: "checkpoint" })),
  );
  const walAfterCheckpointBytes = fileBytes(`${dbPath}-wal`);
  await stopWorkers(workers);
  const inspection = inspectDb(dbPath);

  return {
    topology,
    synchronous,
    clientCount,
    workerCount,
    writesPerClient,
    transactionHoldMs: holdMs,
    startupMs: Number(startupMs.toFixed(3)),
    wallMs: Number(wallMs.toFixed(3)),
    throughputPerSecond: Number(((samples.length / wallMs) * 1000).toFixed(3)),
    latencyMs: stats(samples.map((sample) => sample.latencyMs)),
    writerLockAcquisitionMs: stats(samples.map((sample) => sample.acquisitionMs)),
    transactionMs: stats(samples.map((sample) => sample.transactionMs)),
    busyRetries: samples.reduce((total, sample) => total + sample.busyRetries, 0),
    clientCompletionMs: clientDurations.map((value) => Number(value.toFixed(3))),
    clientCompletionSpreadRatio: Number(
      (Math.max(...clientDurations) / Math.min(...clientDurations)).toFixed(3),
    ),
    distinctObservedWriterPids: new Set(samples.map((sample) => sample.writerPid)).size,
    walBeforeCheckpointBytes,
    walAfterCheckpointBytes,
    checkpointPids: checkpointResponses.map((response) => response.pid),
    checkpointResponses,
    inspection,
    samples: samples.map((sample) => ({
      ...sample,
      latencyMs: Number(sample.latencyMs.toFixed(3)),
      acquisitionMs: Number(sample.acquisitionMs.toFixed(3)),
      transactionMs: Number(sample.transactionMs.toFixed(3)),
    })),
  };
}

async function timedRequest(
  worker: WorkerHandle,
  request: RequestInput,
): Promise<{ elapsedMs: number; response: Response }> {
  const started = performance.now();
  const response = await worker.request(request);
  return { elapsedMs: performance.now() - started, response };
}

function requestWithTransactionStarted(
  worker: WorkerHandle,
  request: Extract<RequestInput, { op: "write" }>,
): { started: Promise<void>; completed: Promise<Response> } {
  let startedResolve!: () => void;
  let startedReject!: (error: Error) => void;
  let didStart = false;
  const started = new Promise<void>((resolve, reject) => {
    startedResolve = resolve;
    startedReject = reject;
  });
  const completed = worker.request(request, () => {
    didStart = true;
    startedResolve();
  });
  void completed.then(
    () => {
      if (!didStart) startedReject(new Error("write completed without a transaction-start signal"));
    },
    (error) => startedReject(error instanceof Error ? error : new Error(String(error))),
  );
  return { started, completed };
}

async function runEventLoopIsolation(root: string): Promise<Record<string, unknown>> {
  const centralPath = join(root, "central-event-loop.sqlite");
  const central = await startWorker("central", "gateway", centralPath, "NORMAL");
  const centralLongWrite = requestWithTransactionStarted(central, {
    op: "write",
    sourceId: "central-long-write",
    clientId: "blocking-client",
    sequence: 0,
    holdMs: 250,
  });
  await centralLongWrite.started;
  await Bun.sleep(25);
  const centralPing = await timedRequest(central, { op: "ping" });
  await centralLongWrite.completed;
  await stopWorkers([central]);

  const federatedPath = join(root, "federated-event-loop.sqlite");
  const federatedWorkers = await startWorkerGroup([
    {
      topology: "federated",
      workerId: "worker-0",
      dbPath: federatedPath,
      synchronous: "NORMAL",
    },
    {
      topology: "federated",
      workerId: "worker-1",
      dbPath: federatedPath,
      synchronous: "NORMAL",
    },
  ]);
  const federatedLongWrite = requestWithTransactionStarted(federatedWorkers[0]!, {
    op: "write",
    sourceId: "federated-long-write",
    clientId: "blocking-client",
    sequence: 0,
    holdMs: 250,
  });
  await federatedLongWrite.started;
  await Bun.sleep(25);
  const [sameProcessPing, unrelatedProcessPing] = await Promise.all([
    timedRequest(federatedWorkers[0]!, { op: "ping" }),
    timedRequest(federatedWorkers[1]!, { op: "ping" }),
  ]);
  await federatedLongWrite.completed;
  await stopWorkers(federatedWorkers);

  return {
    transactionHoldMs: 250,
    pingSentAfterConfirmedTransactionStartMs: 25,
    centralGatewayPingMs: Number(centralPing.elapsedMs.toFixed(3)),
    federatedSameWriterPingMs: Number(sameProcessPing.elapsedMs.toFixed(3)),
    federatedUnrelatedWriterPingMs: Number(unrelatedProcessPing.elapsedMs.toFixed(3)),
    observation:
      "Synchronous SQLite work stalls the owning process event loop; the federated topology leaves another process event loop available.",
  };
}

async function expectCrash(request: Promise<Response>, worker: WorkerHandle): Promise<number> {
  try {
    await request;
  } catch (error) {
    const code = await worker.exited;
    const message = error instanceof Error ? error.message : String(error);
    if (code !== 137 || !message.includes("exited 137")) {
      throw new Error(`expected immediate SIGKILL exit, got code=${code}, error=${message}`);
    }
    return code;
  }
  await stopWorkers([worker]);
  throw new Error("expected worker crash");
}

async function runCrashIsolation(root: string): Promise<Record<string, unknown>> {
  const centralPath = join(root, "central-crash.sqlite");
  const central = await startWorker("central", "gateway", centralPath, "FULL");
  const centralExit = await expectCrash(
    central.request({
      op: "write",
      sourceId: "central-ambiguous",
      clientId: "client",
      sequence: 0,
      holdMs: 0,
      crashAfterCommit: true,
    }),
    central,
  );
  const centralRestartStarted = performance.now();
  const restartedCentral = await startWorker("central", "gateway-restart", centralPath, "FULL");
  const centralRestartMs = performance.now() - centralRestartStarted;
  const centralRetry = await restartedCentral.request({
    op: "write",
    sourceId: "central-ambiguous",
    clientId: "client",
    sequence: 0,
    holdMs: 0,
  });
  await stopWorkers([restartedCentral]);

  const federatedPath = join(root, "federated-crash.sqlite");
  const federated = await startWorkerGroup([
    {
      topology: "federated",
      workerId: "worker-0",
      dbPath: federatedPath,
      synchronous: "FULL",
    },
    {
      topology: "federated",
      workerId: "worker-1",
      dbPath: federatedPath,
      synchronous: "FULL",
    },
  ]);
  const federatedExit = await expectCrash(
    federated[0]!.request({
      op: "write",
      sourceId: "federated-ambiguous",
      clientId: "client-0",
      sequence: 0,
      holdMs: 0,
      crashAfterCommit: true,
    }),
    federated[0]!,
  );
  const survivingPing = await timedRequest(federated[1]!, { op: "ping" });
  const survivingWrite = await federated[1]!.request({
    op: "write",
    sourceId: "federated-unrelated",
    clientId: "client-1",
    sequence: 0,
    holdMs: 0,
  });
  const restartedFederated = await startWorker(
    "federated",
    "worker-0-restart",
    federatedPath,
    "FULL",
  );
  const federatedRetry = await restartedFederated.request({
    op: "write",
    sourceId: "federated-ambiguous",
    clientId: "client-0",
    sequence: 0,
    holdMs: 0,
  });
  await stopWorkers([federated[1]!, restartedFederated]);

  return {
    central: {
      crashExitCode: centralExit,
      soleObservedWriterExitedBeforeRestart: centralExit !== 0,
      restartToReadyMs: Number(centralRestartMs.toFixed(3)),
      ambiguousRetryReturnedExisting:
        centralRetry.ok && centralRetry.op === "write" && centralRetry.existing,
      inspection: inspectDb(centralPath),
    },
    federated: {
      crashExitCode: federatedExit,
      survivingProcessPingMs: Number(survivingPing.elapsedMs.toFixed(3)),
      survivingProcessCommitted:
        survivingWrite.ok && survivingWrite.op === "write" && !survivingWrite.existing,
      ambiguousRetryReturnedExisting:
        federatedRetry.ok && federatedRetry.op === "write" && federatedRetry.existing,
      inspection: inspectDb(federatedPath),
    },
  };
}

async function runDatabaseIdentity(root: string): Promise<Record<string, unknown>> {
  const cwdA = join(root, "launcher-a");
  const cwdB = join(root, "launcher-b");
  mkdirSync(cwdA, { recursive: true });
  mkdirSync(cwdB, { recursive: true });

  const centralRelative = "central-relative.sqlite";
  const central = await startWorker("central", "gateway", centralRelative, "NORMAL", cwdA);
  await central.request({
    op: "write",
    sourceId: "central-path",
    clientId: "client-from-any-cwd",
    sequence: 0,
    holdMs: 0,
  });
  await stopWorkers([central]);

  const federatedRelative = "federated-relative.sqlite";
  const federated = await startWorkerGroup([
    {
      topology: "federated",
      workerId: "launcher-a",
      dbPath: federatedRelative,
      synchronous: "NORMAL",
      cwd: cwdA,
    },
    {
      topology: "federated",
      workerId: "launcher-b",
      dbPath: federatedRelative,
      synchronous: "NORMAL",
      cwd: cwdB,
    },
  ]);
  await Promise.all([
    federated[0]!.request({
      op: "write",
      sourceId: "federated-path-a",
      clientId: "launcher-a",
      sequence: 0,
      holdMs: 0,
    }),
    federated[1]!.request({
      op: "write",
      sourceId: "federated-path-b",
      clientId: "launcher-b",
      sequence: 0,
      holdMs: 0,
    }),
  ]);
  await stopWorkers(federated);

  const centralFiles = [join(cwdA, centralRelative), join(cwdB, centralRelative)].filter(existsSync);
  const federatedFiles = [join(cwdA, federatedRelative), join(cwdB, federatedRelative)].filter(existsSync);
  return {
    sameRelativeConfiguration: true,
    centralDatabaseFiles: centralFiles.map((path) => relative(root, path)),
    federatedDatabaseFiles: federatedFiles.map((path) => relative(root, path)),
    observation:
      "A path resolved once by the gateway produced one database; independently resolved relative paths produced two databases from two launcher working directories.",
    limitation:
      "This is a configuration-risk discriminator, not an inherent requirement that federated launchers use relative paths.",
  };
}

function gitRevision(): string {
  return Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" })
    .stdout.toString()
    .trim();
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "octo-santa-PROTOTYPE-WIPE-topology-evidence-"));
  try {
    const loads: Record<string, unknown>[] = [];
    for (const synchronous of ["NORMAL", "FULL"] as const) {
      for (const clientCount of [1, 5, 10]) {
        loads.push(await runLoad(root, "central", synchronous, clientCount));
        loads.push(await runLoad(root, "federated", synchronous, clientCount));
      }
    }

    const eventLoopIsolation = await runEventLoopIsolation(root);
    const crashIsolation = await runCrashIsolation(root);
    const databaseIdentity = await runDatabaseIdentity(root);
    const evidence = {
    prototype: "PROTOTYPE/WIPE process topology evidence",
    question:
      "What measured process-level differences constrain a central single-writer gateway versus federated N-writer processes?",
    baseline: {
      repositoryCommit: gitRevision(),
      bunVersion: Bun.version,
      sqliteVersion: (() => {
        const db = new Database(":memory:");
        const version = String(
          (db.query("SELECT sqlite_version() AS version").get() as { version: string }).version,
        );
        db.close();
        return version;
      })(),
      platform: process.platform,
      arch: process.arch,
      scratchDirectory: "<temporary-directory>",
    },
    structuralEnforcement: {
      central:
        "One persistent gateway worker receives every request and is the only steady-state process given the database path.",
      federated:
        "Each persistent worker receives the database path, opens its own SQLite connection, and handles only its assigned clients.",
      audit:
        "Every SQLite-opening worker records its PID and role in connection_audit; load results report the observed rows.",
    },
    measurements: {
      loadMatrix: loads,
      eventLoopIsolation,
      crashIsolation,
      databaseIdentity,
    },
    observations: [
      "Both candidates committed the complete deterministic workload with integrity_check=ok in this local process-level probe.",
      "The central candidate used one observed writer PID per run; the federated candidate used one observed writer PID per client process.",
      "SQLite serialized federated write transactions through measurable writer-lock acquisition; the central gateway instead exposed application queueing in request latency.",
      "A long synchronous transaction delayed all central gateway control traffic and same-process federated traffic, while an unrelated federated process remained responsive.",
      "The sole central writer process exited before its replacement started; killing one federated writer left another writer responsive and able to commit.",
      "Idempotent retry after an after-commit process kill recovered the original row in both candidates while the OS remained alive.",
      "Relative database paths split federated launchers by working directory in the explicit identity probe; central resolution produced one database because only the gateway received the path.",
    ],
    judgments: [
      "Centralization buys explicit writer, checkpoint, and database-identity ownership at the cost of one synchronous event-loop and availability boundary.",
      "Federation buys process failure and event-loop isolation at the cost of distributed lock waiting, lifecycle policy, and database-path discipline.",
      "Local latency results are evidence about this Bun/macOS/filesystem baseline, not a universal performance ranking.",
      "The observations constrain but do not decide the architecture because recovery objectives, supervision, rollout, backup, and target-platform requirements remain product choices.",
    ],
    northStarDisposition: {
      surviveAsTopologyNeutralRequirementsButWereNotRemeasuredHere: [
        "SQLite persistence remains authoritative before acknowledgement.",
        "Submission is not Observation; model visibility requires separate evidence.",
        "Cross-process delivery must not depend on shared memory.",
        "Ordering remains scoped to one Route Binding so unrelated bindings can progress.",
        "Ambiguous source retries require stable idempotency identity.",
        "Wrapper-attested sender authority remains governed by ADR-0001.",
      ],
      superseded: [],
      topologyCoupledBehaviorsAwaitingHumanSelection: [
        "Every launcher opens SQLite and participates in migration/checkpoint policy.",
        "One gateway process owns the complete write and lifecycle plane.",
      ],
      reason:
        "The reopened prototype selected no topology, so it cannot truthfully supersede either topology-coupled behavior.",
    },
    unmeasuredOrInconclusive: [
      "Host, kernel, VM, storage-device, and power-loss durability; process kills only test application-process recovery while the OS remains alive.",
      "Mixed old/new schema binaries, long readers spanning DDL, slow or failed migrations, and startup version gates.",
      "Restore-tested online backup under uncheckpointed WAL and its source-write/event-loop impact.",
      "Target-hardware and supported-OS capacity, realistic transaction mixes, resource crossover, and production tail-latency budgets.",
      "Queue fairness and starvation bounds; client-completion spread is reported only as a descriptive local measurement.",
      "WAL growth over time and truncation/reclamation; the probe records one pre-checkpoint size and passive-checkpoint frame result per run.",
      "Singleton acquisition, stale sockets, supervisor restart loops, reconnect/backoff, bounded drain, and in-flight request outcome protocols.",
      "A governed dual-plane handoff protocol; the corrected prototype does not invent one to make a transition pass.",
      "Fresh offline wake-up, per-Route-Binding ordering, Submission/Observation, and MCP compatibility probes; these topology-neutral requirements are not used as selection evidence.",
    ],
    decision: {
      topologySelected: null,
      returnedToHumanArchitectureJudgment: true,
      reason:
        "The structurally different candidates exhibit real and opposing operational tradeoffs; selecting one requires the unresolved product objectives rather than another hard-coded prototype pass rule.",
    },
    };

    const outputArgument = process.argv.indexOf("--output");
    const outputPath =
      outputArgument >= 0
        ? process.argv[outputArgument + 1]
        : join(root, "PROTOTYPE-WIPE-process-topology-evidence.json");
    if (!outputPath) throw new Error("--output requires a path");
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify({ outputPath, decision: evidence.decision }, null, 2));
  } finally {
    await stopWorkers([...liveWorkers]);
  }
}

if (process.argv[2] === "--worker") {
  await runWorker(process.argv.slice(3));
} else {
  await main();
}
