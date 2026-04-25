// tests/hex/core/safety-rails-cross-process.test.ts
import { describe, it, expect, afterEach } from "bun:test";
import { cleanupDb } from "../../helpers/db";
import { createDb } from "../../../src/storage/sqlite/db";
import { runMigrations, allMigrations } from "../../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../../src/storage/sqlite";
import { MessagingService } from "../../../src/core/messaging/service";
import { existsSync, unlinkSync } from "fs";

const projectRoot = process.cwd();
const TEST_DB = `/tmp/octo-santa-test-safety-rails-cross-process-${process.pid}.sqlite`;

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("hop counter atomicity across processes", () => {
  it("two worker processes share hop counter via SQLite -- total messages capped at explicit max_hops=4", async () => {
    // ── Setup: create channel with explicit max_hops=4 in main process ─────
    {
      const db = createDb(TEST_DB);
      runMigrations(db, allMigrations);
      const repos = createSqliteRepos(db);
      const svc = new MessagingService(
        repos.agents,
        repos.channels,
        repos.messages,
        repos.cursors,
        process.pid
      );

      svc.register("worker-a");
      svc.register("worker-b");
      svc.createChannel("worker-a", "hop-test", 4); // explicit max_hops=4 for this test
      svc.subscribe("worker-a", "hop-test");
      svc.subscribe("worker-b", "hop-test");

      // Unregister so workers can re-register under their own PIDs
      svc.unregister("worker-a");
      svc.unregister("worker-b");
      db.close();
    }

    // ── Worker script: tries to send 3 messages, handles hop limit gracefully ──
    const makeWorkerScript = (agentId: string) => `
      import { createDb } from "${projectRoot}/src/storage/sqlite/db";
      import { runMigrations, allMigrations } from "${projectRoot}/src/storage/sqlite/migrations";
      import { createSqliteRepos } from "${projectRoot}/src/storage/sqlite";
      import { MessagingService } from "${projectRoot}/src/core/messaging/service";

      const db = createDb("${TEST_DB}");
      runMigrations(db, allMigrations);
      const repos = createSqliteRepos(db);
      const svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid);

      svc.register("${agentId}");

      let sent = 0;
      for (let i = 0; i < 3; i++) {
        try {
          svc.send("${agentId}", "hop-test", "msg-${agentId}-" + i);
          sent++;
        } catch (e) {
          // Hop limit reached -- expected
          break;
        }
      }

      db.close();
      process.exit(0);
    `;

    const workerPathA = "/tmp/octo-santa-hop-worker-a.ts";
    const workerPathB = "/tmp/octo-santa-hop-worker-b.ts";
    await Bun.write(workerPathA, makeWorkerScript("worker-a"));
    await Bun.write(workerPathB, makeWorkerScript("worker-b"));

    // ── Spawn both workers concurrently ────────────────────────────────────
    const workerA = Bun.spawn(["bun", "run", workerPathA], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const workerB = Bun.spawn(["bun", "run", workerPathB], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitA, exitB] = await Promise.all([workerA.exited, workerB.exited]);

    if (exitA !== 0) {
      const stderr = await new Response(workerA.stderr).text();
      console.error(`Worker A failed (code ${exitA}): ${stderr}`);
    }
    if (exitB !== 0) {
      const stderr = await new Response(workerB.stderr).text();
      console.error(`Worker B failed (code ${exitB}): ${stderr}`);
    }

    expect(exitA).toBe(0);
    expect(exitB).toBe(0);

    // ── Verify: exactly 4 non-system messages and hop_count=4 ──────────────
    const db2 = createDb(TEST_DB);
    runMigrations(db2, allMigrations);

    const channelRow = db2
      .query<{ id: number; hop_count: number }, [string]>(
        "SELECT id, hop_count FROM channels WHERE name = ?"
      )
      .get("hop-test");

    expect(channelRow).not.toBeNull();
    const channelId = channelRow!.id;

    const userMessages = db2
      .query<{ id: number; content: string; agent_id: string }, [number]>(
        "SELECT id, content, agent_id FROM messages WHERE channel_id = ? AND agent_id != '_system' ORDER BY id"
      )
      .all(channelId);

    // Exactly 4 messages got through (hop counter shared atomically)
    expect(userMessages.length).toBe(4);

    // hop_count is exactly 4 (at the limit)
    expect(channelRow!.hop_count).toBe(4);

    // Both workers contributed at least 1 message (not one process monopolised all 4)
    const fromA = userMessages.filter((m) => m.agent_id === "worker-a").length;
    const fromB = userMessages.filter((m) => m.agent_id === "worker-b").length;
    expect(fromA).toBeGreaterThanOrEqual(1);
    expect(fromB).toBeGreaterThanOrEqual(1);

    db2.close();

    // Cleanup temp worker files
    for (const p of [workerPathA, workerPathB]) {
      if (existsSync(p)) unlinkSync(p);
    }
  });
});
