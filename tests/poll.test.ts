import { describe, it, expect, afterEach } from "bun:test";
import { cleanupDb, testDbPath, setupTestDb } from "./helpers/db";
import { allMigrations } from "../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../src/storage/sqlite";
import { MessagingService } from "../src/core/messaging/service";

const TEST_DB = testDbPath("poll");
const projectRoot = process.cwd();

afterEach(() => cleanupDb(TEST_DB));

async function runPoll(args: string[]): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(["bun", "run", `${projectRoot}/src/poll.ts`, ...args], {
    env: { ...process.env, OCTO_SANTA_DB: TEST_DB },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  return { exitCode, stdout };
}

describe("poll entry point", () => {
  it("exits 1 with empty unread when there are no new messages", async () => {
    const db = setupTestDb(TEST_DB, allMigrations);
    const repos = createSqliteRepos(db);
    const svc = new MessagingService(repos.agents, repos.channels, repos.messages, process.pid);
    svc.register("reader");
    svc.createChannel("reader", "general");
    db.close();

    const { exitCode, stdout } = await runPoll(["--as", "reader"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toEqual({ agent: "reader", unread: [] });
  });

  it("exits 0 and reports unread without consuming them", async () => {
    const db = setupTestDb(TEST_DB, allMigrations);
    const repos = createSqliteRepos(db);
    const svc = new MessagingService(repos.agents, repos.channels, repos.messages, process.pid);
    svc.register("reader");
    svc.register("sender");
    svc.createChannel("sender", "general");
    svc.subscribe("reader", "general");
    svc.send("sender", "general", "hello @reader");

    const first = await runPoll(["--as", "reader"]);
    expect(first.exitCode).toBe(0);
    const parsed = JSON.parse(first.stdout);
    expect(parsed.unread).toHaveLength(1);
    expect(parsed.unread[0].channel).toBe("general");
    expect(parsed.unread[0].count).toBe(1);
    expect(parsed.unread[0].messages[0].from).toBe("sender");
    expect(parsed.unread[0].messages[0].content).toBe("hello @reader");

    // Read-only proof: a second poll still sees the message ...
    const second = await runPoll(["--as", "reader"]);
    expect(second.exitCode).toBe(0);

    // ... and so does a real read, which then consumes it.
    const messages = svc.read("reader", "general");
    expect(messages).toHaveLength(1);

    const third = await runPoll(["--as", "reader"]);
    expect(third.exitCode).toBe(1);
    db.close();
  });

  it("scopes to a single channel with --channel", async () => {
    const db = setupTestDb(TEST_DB, allMigrations);
    const repos = createSqliteRepos(db);
    const svc = new MessagingService(repos.agents, repos.channels, repos.messages, process.pid);
    svc.register("reader");
    svc.register("sender");
    svc.createChannel("sender", "general");
    svc.createChannel("sender", "other");
    svc.subscribe("reader", "general");
    svc.subscribe("reader", "other");
    svc.send("sender", "other", "elsewhere");
    db.close();

    const { exitCode, stdout } = await runPoll(["--as", "reader", "--channel", "general"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout).unread).toEqual([]);

    const other = await runPoll(["--as", "reader", "--channel", "other"]);
    expect(other.exitCode).toBe(0);
  });

  it("exits 2 without --as", async () => {
    setupTestDb(TEST_DB, allMigrations).close();
    const { exitCode } = await runPoll([]);
    expect(exitCode).toBe(2);
  });
});

describe("poll entry point — watch mode (--interval)", () => {
  it("keeps polling until a message arrives, then exits 0 with it", async () => {
    const db = setupTestDb(TEST_DB, allMigrations);
    const repos = createSqliteRepos(db);
    const svc = new MessagingService(repos.agents, repos.channels, repos.messages, process.pid);
    svc.register("reader");
    svc.register("sender");
    svc.createChannel("sender", "general");
    svc.subscribe("reader", "general");

    // Start watching with no unread; send only after the watcher is running.
    const pollPromise = runPoll(["--as", "reader", "--interval", "0.2"]);
    await Bun.sleep(500);
    svc.send("sender", "general", "wake up @reader");

    const { exitCode, stdout } = await pollPromise;
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.unread[0].channel).toBe("general");
    expect(parsed.unread[0].messages[0].content).toBe("wake up @reader");
    db.close();
  });

  it("gives up after --timeout and exits 1 with empty unread", async () => {
    const db = setupTestDb(TEST_DB, allMigrations);
    const repos = createSqliteRepos(db);
    const svc = new MessagingService(repos.agents, repos.channels, repos.messages, process.pid);
    svc.register("reader");
    svc.createChannel("reader", "general");
    db.close();

    const start = Date.now();
    const { exitCode, stdout } = await runPoll([
      "--as", "reader", "--interval", "0.2", "--timeout", "0.7",
    ]);
    const elapsed = Date.now() - start;

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toEqual({ agent: "reader", unread: [] });
    expect(elapsed).toBeGreaterThanOrEqual(700);
    expect(elapsed).toBeLessThan(5000);
  });

  it("exits 2 on a non-positive --interval", async () => {
    setupTestDb(TEST_DB, allMigrations).close();
    const { exitCode } = await runPoll(["--as", "reader", "--interval", "0"]);
    expect(exitCode).toBe(2);
  });

  it("exits 2 when --timeout is given without --interval", async () => {
    setupTestDb(TEST_DB, allMigrations).close();
    const { exitCode } = await runPoll(["--as", "reader", "--timeout", "5"]);
    expect(exitCode).toBe(2);
  });
});
