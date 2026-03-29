// tests/repl/cli.test.ts
import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "fs";

const TEST_DB = "/tmp/octo-santa-test-cli.sqlite";
const TEST_FILE = "/tmp/octo-santa-test-cli-brief.md";

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = path + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
}

afterEach(() => {
  cleanupDb(TEST_DB);
  if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);
});

describe("CLI process", () => {
  it("send mode sends file and prints message ID", async () => {
    cleanupDb(TEST_DB);
    writeFileSync(TEST_FILE, "hello from cli test");

    const proc = Bun.spawn(
      ["bun", "run", "src/repl/index.ts", "send", "--as", "jay", "-c", "planning", "-f", TEST_FILE],
      { env: { ...process.env, OCTO_SANTA_DB: TEST_DB }, stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(parseInt(stdout.trim())).toBeGreaterThan(0); // message ID
  });

  it("send mode without -f and without pipe shows error", async () => {
    cleanupDb(TEST_DB);

    const proc = Bun.spawn(
      ["bun", "run", "src/repl/index.ts", "send", "--as", "jay", "-c", "planning"],
      {
        env: { ...process.env, OCTO_SANTA_DB: TEST_DB },
        stdout: "pipe",
        stderr: "pipe",
        stdin: null, // no pipe — stdin is closed
      }
    );
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).not.toBe(0);
    // Bun treats stdin: null as a closed FD (not a TTY), so isTTY is false and the
    // process reads empty content instead — the validation error still fires, just
    // with "message content must not be empty" rather than the isTTY-specific message.
    expect(stderr.length).toBeGreaterThan(0);
  });

  it("exits with error when --as is missing", async () => {
    cleanupDb(TEST_DB);

    const proc = Bun.spawn(
      ["bun", "run", "src/repl/index.ts", "send", "-c", "planning"],
      { env: { ...process.env, OCTO_SANTA_DB: TEST_DB }, stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--as");
  });

  it("send mode with piped stdin works", async () => {
    cleanupDb(TEST_DB);

    const proc = Bun.spawn(
      ["bun", "run", "src/repl/index.ts", "send", "--as", "jay", "-c", "planning"],
      { env: { ...process.env, OCTO_SANTA_DB: TEST_DB }, stdout: "pipe", stderr: "pipe", stdin: "pipe" }
    );
    proc.stdin.write("piped message content");
    proc.stdin.end();

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(parseInt(stdout.trim())).toBeGreaterThan(0);
  });
});
