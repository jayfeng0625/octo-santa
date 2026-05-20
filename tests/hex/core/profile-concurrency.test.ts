// tests/hex/core/profile-concurrency.test.ts
//
// Cross-process concurrency tests for profile-aware registration.
// Uses Bun.spawn worker pattern to simulate multiple processes racing
// for profile pool slots via SQLite EXCLUSIVE transactions.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupDb } from "../../helpers/db";
import { createDb } from "../../../src/storage/sqlite/db";
import { runMigrations, allMigrations } from "../../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../../src/storage/sqlite";
import { MessagingService } from "../../../src/core/messaging/service";
import { YamlProfileStore } from "../../../src/storage/yaml-profiles/store";
import { SqliteNotificationQueryRepo } from "../../../src/storage/sqlite/notification-query-repo";
import { createNotificationPoller } from "../../../src/notifications/poller/poller";
import type { NotificationPort } from "../../../src/core/ports";

const projectRoot = process.cwd();

// Use a fixed (non-PID-suffixed) path so workers can share the same DB.
const TEST_DB = `/tmp/octo-santa-test-profile-concurrency.sqlite`;

let tempProfileDirs: string[] = [];

afterEach(() => {
  cleanupDb(TEST_DB);
  for (const dir of tempProfileDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
  tempProfileDirs = [];
});

function makeTempProfileDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "octo-santa-profiles-"));
  tempProfileDirs.push(dir);
  return dir;
}

function writeProfileYaml(dir: string, name: string, maxInstances: number): void {
  const content = `name: ${name}\nmaxInstances: ${maxInstances}\n`;
  writeFileSync(join(dir, `${name}.yaml`), content, "utf-8");
}

// Worker script template — runs from /tmp so all imports use absolute paths.
function makeWorkerScript(profileDir: string, agentName: string): string {
  return `
import { createDb } from "${projectRoot}/src/storage/sqlite/db";
import { runMigrations, allMigrations } from "${projectRoot}/src/storage/sqlite/migrations";
import { createSqliteRepos } from "${projectRoot}/src/storage/sqlite";
import { MessagingService } from "${projectRoot}/src/core/messaging/service";
import { YamlProfileStore } from "${projectRoot}/src/storage/yaml-profiles/store";

const db = createDb("${TEST_DB}");
runMigrations(db, allMigrations);
const repos = createSqliteRepos(db);
const profiles = new YamlProfileStore("${profileDir}");
const svc = new MessagingService(
  repos.agents,
  repos.channels,
  repos.messages,
  repos.cursors,
  process.pid,
  undefined,
  profiles
);

try {
  const result = svc.register("${agentName}");
  console.log(JSON.stringify({ ok: true, registeredName: result.registeredName }));
  db.close();
} catch (err) {
  console.error(err.message);
  db.close();
  process.exit(1);
}
`;
}

describe("cross-process profile registration concurrency", () => {
  it("(a) singleton race: 2 workers racing for maxInstances=1 — exactly 1 succeeds", async () => {
    const profileDir = makeTempProfileDir();
    writeProfileYaml(profileDir, "os-pm", 1);

    // Set up the DB on disk first (workers will call runMigrations themselves,
    // but we need the file to exist for cleanupDb to work in afterEach).
    const setupDb = createDb(TEST_DB);
    runMigrations(setupDb, allMigrations);
    setupDb.close();

    const workerScript = makeWorkerScript(profileDir, "os-pm");
    const workerPath = "/tmp/octo-santa-profile-concurrency-singleton-worker.ts";
    await Bun.write(workerPath, workerScript);

    // Spawn 2 workers simultaneously
    const workers = [0, 1].map(() =>
      Bun.spawn(["bun", "run", workerPath], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      })
    );

    const exitCodes = await Promise.all(workers.map((w) => w.exited));

    // Gather output for diagnostics
    const outputs = await Promise.all(
      workers.map(async (w, i) => ({
        idx: i,
        code: exitCodes[i],
        stdout: await new Response(w.stdout).text(),
        stderr: await new Response(w.stderr).text(),
      }))
    );

    const succeeded = outputs.filter((o) => o.code === 0);
    const failed = outputs.filter((o) => o.code !== 0);

    if (succeeded.length !== 1) {
      console.error("Unexpected results:", JSON.stringify(outputs, null, 2));
    }

    // Exactly 1 worker should have succeeded
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    // The failed worker should have reported already-active or at-capacity error
    const failedStderr = failed[0]!.stderr;
    const isExpectedError =
      failedStderr.includes("already active") ||
      failedStderr.includes("at capacity");
    expect(isExpectedError).toBe(true);

    // Verify DB has exactly 1 agent row for os-pm
    const db = createDb(TEST_DB);
    const rows = db.query("SELECT id FROM agents WHERE id = 'os-pm' OR base_name = 'os-pm'").all() as { id: string }[];
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("os-pm");
  });

  it("(b) pool race: 3 workers racing for 3 slots — all succeed with unique names", async () => {
    const profileDir = makeTempProfileDir();
    writeProfileYaml(profileDir, "os-dev", 3);

    // Set up the DB on disk first
    const setupDb = createDb(TEST_DB);
    runMigrations(setupDb, allMigrations);
    setupDb.close();

    const workerScript = makeWorkerScript(profileDir, "os-dev");
    const workerPath = "/tmp/octo-santa-profile-concurrency-pool-worker.ts";
    await Bun.write(workerPath, workerScript);

    // Spawn 3 workers simultaneously
    const workers = [0, 1, 2].map(() =>
      Bun.spawn(["bun", "run", workerPath], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      })
    );

    const exitCodes = await Promise.all(workers.map((w) => w.exited));

    const outputs = await Promise.all(
      workers.map(async (w, i) => ({
        idx: i,
        code: exitCodes[i],
        stdout: await new Response(w.stdout).text(),
        stderr: await new Response(w.stderr).text(),
      }))
    );

    const succeeded = outputs.filter((o) => o.code === 0);
    const failed = outputs.filter((o) => o.code !== 0);

    if (succeeded.length !== 3) {
      console.error("Unexpected results:", JSON.stringify(outputs, null, 2));
    }

    // All 3 workers should succeed
    expect(succeeded).toHaveLength(3);
    expect(failed).toHaveLength(0);

    // Parse registered names from stdout
    const registeredNames = succeeded.map((o) => {
      const parsed = JSON.parse(o.stdout.trim()) as { ok: boolean; registeredName: string };
      return parsed.registeredName;
    });

    // All names should be unique
    const uniqueNames = new Set(registeredNames);
    expect(uniqueNames.size).toBe(3);

    // All names should match os-dev-1, os-dev-2, os-dev-3 (in any order)
    const expected = new Set(["os-dev-1", "os-dev-2", "os-dev-3"]);
    for (const name of registeredNames) {
      expect(expected.has(name)).toBe(true);
    }

    // Verify DB has exactly 3 agent rows with base_name = 'os-dev'
    const db = createDb(TEST_DB);
    const rows = db
      .query("SELECT id FROM agents WHERE base_name = 'os-dev' ORDER BY id")
      .all() as { id: string }[];
    db.close();

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.id)).toEqual(["os-dev-1", "os-dev-2", "os-dev-3"]);
  });

  it("(c) cross-process: pool base-name mention triggers poller notification", async () => {
    const profileDir = makeTempProfileDir();
    writeProfileYaml(profileDir, "os-dev", 3);

    // Set up DB and register os-dev → os-dev-1, create + subscribe to channel
    const db = createDb(TEST_DB);
    runMigrations(db, allMigrations);
    const repos = createSqliteRepos(db);
    const profiles = new YamlProfileStore(profileDir);
    const svc = new MessagingService(
      repos.agents,
      repos.channels,
      repos.messages,
      repos.cursors,
      process.pid,
      undefined,
      profiles
    );

    const result = svc.register("os-dev");
    expect(result.registeredName).toBe("os-dev-1");

    svc.createChannel("os-dev-1", "work");
    svc.subscribe("os-dev-1", "work");
    db.close();

    // Spawn worker: registers as "sender", subscribes to "work", sends @os-dev mention.
    // Must pass the YamlProfileStore so extractMentions recognises "os-dev" as a pool base name.
    const workerScript = `
import { createDb } from "${projectRoot}/src/storage/sqlite/db";
import { runMigrations, allMigrations } from "${projectRoot}/src/storage/sqlite/migrations";
import { createSqliteRepos } from "${projectRoot}/src/storage/sqlite";
import { MessagingService } from "${projectRoot}/src/core/messaging/service";
import { YamlProfileStore } from "${projectRoot}/src/storage/yaml-profiles/store";

const db = createDb("${TEST_DB}");
runMigrations(db, allMigrations);
const repos = createSqliteRepos(db);
const profiles = new YamlProfileStore("${profileDir}");
const svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid, undefined, profiles);

svc.register("sender");
svc.subscribe("sender", "work");
svc.send("sender", "work", "Hey @os-dev please review");
db.close();
`;

    const tmpWorker = "/tmp/octo-santa-poller-mention-worker.ts";
    await Bun.write(tmpWorker, workerScript);
    const proc = Bun.spawn(["bun", "run", tmpWorker], {
      cwd: projectRoot,
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Worker failed: ${stderr}`);
    }

    // Open a fresh DB connection for the poller
    const db2 = createDb(TEST_DB);
    const notificationQueries = new SqliteNotificationQueryRepo(db2);

    const notifications: Array<{ content: string; meta: Record<string, string> }> = [];
    const port: NotificationPort = {
      notify: async (content, meta) => {
        notifications.push({ content, meta });
      },
    };

    const poller = createNotificationPoller({
      getNewMessagesForAgent: notificationQueries.getNewMessagesForAgent.bind(notificationQueries),
      getMaxMessageId: notificationQueries.getMaxMessageId.bind(notificationQueries),
      port,
      agentId: "os-dev-1",
      baseName: "os-dev", // Pool base-name match — this is what we're testing
    });

    // Manually tick; hwm starts at 0 so all messages since beginning are picked up
    await poller._tick();

    db2.close();

    // The worker's @os-dev message should have triggered a notification
    expect(notifications.length).toBeGreaterThan(0);
    const mentionNotification = notifications.find((n) => n.content.includes("@os-dev"));
    expect(mentionNotification).toBeDefined();
    expect(mentionNotification!.meta.sender).toBe("sender");
    expect(mentionNotification!.meta.channel_name).toBe("work");
  });
});
