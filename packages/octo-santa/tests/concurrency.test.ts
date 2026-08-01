// tests/concurrency.test.ts
import { describe, it, expect, afterEach } from "bun:test";
import { cleanupDb, testDbPath, setupTestDb } from "./helpers/db";
import { createDb, withRetrySync } from "../src/storage/sqlite/db";
import { runMigrations, allMigrations } from "../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../src/storage/sqlite";
import { MessagingService } from "../src/core/messaging/service";

const TEST_DB = testDbPath("concurrency");
const projectRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function setup() {
  const db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(repos.agents, repos.channels, repos.messages, process.pid);
  return { db, svc };
}

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("concurrency", () => {
  it("handles concurrent writes without losing messages", async () => {
    const { db: setupDbRef, svc } = setup();
    // Subscribe verifier before workers run so cursor starts at 0 (sees all messages)
    svc.register("verifier");
    svc.createChannel("verifier", "stress-test");
    svc.subscribe("verifier", "stress-test");
    setupDbRef.close();

    const NUM_AGENTS = 5;
    const MESSAGES_PER_AGENT = 20;

    // Spawn child processes that each write messages
    // Use absolute paths since workers run from /tmp
    const workerScript = `
      import { createDb } from "${projectRoot}/src/storage/sqlite/db";
      import { runMigrations, allMigrations } from "${projectRoot}/src/storage/sqlite/migrations";
      import { createSqliteRepos } from "${projectRoot}/src/storage/sqlite";
      import { MessagingService } from "${projectRoot}/src/core/messaging/service";

      const db = createDb("${TEST_DB}");
      runMigrations(db, allMigrations);
      const repos = createSqliteRepos(db);
      const svc = new MessagingService(repos.agents, repos.channels, repos.messages, process.pid);

      const agentId = process.argv[2];
      const count = parseInt(process.argv[3]);

      // Register before sending (channel already created by verifier)
      svc.register(agentId);
      for (let i = 0; i < count; i++) {
        svc.send(agentId, "stress-test", \`Message \${i} from \${agentId}\`);
      }
      db.close();
    `;

    const tmpWorker = "/tmp/octo-santa-concurrency-worker.ts";
    await Bun.write(tmpWorker, workerScript);

    // Launch all workers concurrently
    const workers = Array.from({ length: NUM_AGENTS }, (_, i) =>
      Bun.spawn(["bun", "run", tmpWorker, `agent-${i}`, String(MESSAGES_PER_AGENT)], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      })
    );

    // Wait for all workers to finish
    const results = await Promise.all(workers.map((w) => w.exited));

    if (!results.every((code) => code === 0)) {
      for (let i = 0; i < workers.length; i++) {
        if (results[i] !== 0) {
          const stderr = await new Response(workers[i]!.stderr).text();
          console.error(`Worker agent-${i} failed (code ${results[i]}): ${stderr}`);
        }
      }
    }

    expect(results.every((code) => code === 0)).toBe(true);

    // Verify all messages were written
    const db = createDb(TEST_DB);
    runMigrations(db, allMigrations);
    const repos = createSqliteRepos(db);
    const verifySvc = new MessagingService(repos.agents, repos.channels, repos.messages, process.pid);
    // Cursor was already created at 0 before workers ran — just read
    const allMessages = verifySvc.read("verifier", "stress-test", { limit: 1000 });
    expect(allMessages).toHaveLength(NUM_AGENTS * MESSAGES_PER_AGENT);

    db.close();
  });

  it("migration race — multiple processes starting against empty DB", async () => {
    cleanupDb(TEST_DB);

    const workerScript = `
      import { createDb } from "${projectRoot}/src/storage/sqlite/db";
      import { runMigrations, allMigrations } from "${projectRoot}/src/storage/sqlite/migrations";
      import { createSqliteRepos } from "${projectRoot}/src/storage/sqlite";
      import { MessagingService } from "${projectRoot}/src/core/messaging/service";

      const db = createDb("${TEST_DB}");
      runMigrations(db, allMigrations);
      const repos = createSqliteRepos(db);
      const svc = new MessagingService(repos.agents, repos.channels, repos.messages, process.pid);
      const agentId = process.argv[2];
      svc.register(agentId);
      svc.createChannel(agentId, "init"); // idempotent — one winner creates it
      svc.send(agentId, "init", "ready");
      db.close();
    `;

    const tmpWorker = "/tmp/octo-santa-migration-race-worker.ts";
    await Bun.write(tmpWorker, workerScript);

    const NUM_WORKERS = 5;
    const workers = Array.from({ length: NUM_WORKERS }, (_, i) =>
      Bun.spawn(["bun", "run", tmpWorker, `agent-${i}`], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      })
    );

    const results = await Promise.all(workers.map((w) => w.exited));

    if (!results.every((code) => code === 0)) {
      for (let i = 0; i < workers.length; i++) {
        if (results[i] !== 0) {
          const stderr = await new Response(workers[i]!.stderr).text();
          console.error(`Worker agent-${i} failed (code ${results[i]}): ${stderr}`);
        }
      }
    }

    expect(results.every((code) => code === 0)).toBe(true);

    // Verify DB is consistent
    const db = createDb(TEST_DB);
    const migrationRows = db.query("SELECT name FROM schema_migrations").all() as { name: string }[];
    const names = migrationRows.map(r => r.name);
    expect(names).toContain("messaging_001_initial_schema");
    expect(names).toContain("messaging_002_mentions_and_pid");

    // Register verifier with proper PID and create cursor at 0 to read all messages
    const repos = createSqliteRepos(db);
    const verifySvc = new MessagingService(repos.agents, repos.channels, repos.messages, process.pid);
    verifySvc.register("verifier");
    const channel = db.query("SELECT id FROM channels WHERE name = ?").get("init") as { id: number };
    db.run("INSERT INTO cursors (agent_id, channel_id, last_read_message_id) VALUES (?, ?, 0) ON CONFLICT DO NOTHING", ["verifier", channel.id]);
    const messages = verifySvc.read("verifier", "init", { limit: 100 });
    expect(messages).toHaveLength(NUM_WORKERS);

    db.close();
  });
});

describe("withRetrySync under contention", () => {
  it("recovers when a lock holder releases mid-retry", async () => {
    const { db } = setup();

    // withRetrySync uses Bun.sleepSync (fully synchronous), so setTimeout cannot
    // fire while it is retrying. Instead, spawn a subprocess that holds an
    // EXCLUSIVE lock for 300ms then releases it — the main process retries
    // and succeeds once the lock is freed.
    const lockHolderScript = `
      import { createDb } from "${projectRoot}/src/storage/sqlite/db";
      const blocker = createDb("${TEST_DB}");
      blocker.run("BEGIN EXCLUSIVE");
      Bun.sleepSync(300);
      blocker.run("COMMIT");
      blocker.close();
    `;
    const lockHolderPath = "/tmp/octo-santa-lock-holder.ts";
    await Bun.write(lockHolderPath, lockHolderScript);

    const blockerProc = Bun.spawn(["bun", "run", lockHolderPath], {
      stdout: "pipe",
      stderr: "pipe",
    });

    // Give the blocker time to acquire the lock before we attempt our write
    Bun.sleepSync(100);

    // This should retry and succeed once the lock holder releases
    const result = withRetrySync(
      () => {
        db.run(
          "INSERT INTO agents (id, created_at, last_seen_at) VALUES (?, ?, ?)",
          ["retry-agent", Date.now(), Date.now()]
        );
        return db.query("SELECT * FROM agents WHERE id = ?").get("retry-agent");
      },
      5,   // maxRetries — enough to outlast the 300ms hold
      200  // baseDelayMs
    );

    expect(result).not.toBeNull();

    await blockerProc.exited;
    db.close();
  });
});
