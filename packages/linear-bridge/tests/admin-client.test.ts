// Exercises the REAL admin server subprocess — this is the proof that the
// bridge can consume octo-santa purely over the MCP stdio boundary, with no
// source imports.
import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { AdminClient } from "../src/admin-client";

const TEST_DB = `/tmp/linear-bridge-test-client-${process.pid}.sqlite`;

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = path + suffix;
    if (existsSync(file)) unlinkSync(file);
  }
}

let client: AdminClient | null = null;

afterEach(async () => {
  await client?.close();
  client = null;
  cleanupDb(TEST_DB);
});

function makeClient(): AdminClient {
  client = new AdminClient({ env: { OCTO_SANTA_DB: TEST_DB } });
  return client;
}

describe("AdminClient against the real admin server", () => {
  it("discovers sendMessage via admin_search", async () => {
    const c = makeClient();
    const found = await c.search("send message");
    expect(found.total).toBeGreaterThan(0);
    expect(found.matches.map((m) => m.name)).toContain("sendMessage");
    const match = found.matches.find((m) => m.name === "sendMessage")!;
    expect(match.module).toBe("storage");
    expect(match.declaration).toContain("sendMessage(input: SendMessageInput)");
  });

  it("executes code and returns its value and logs", async () => {
    const c = makeClient();
    const outcome = await c.execute('console.log("hello"); return 1 + 41;');
    expect(outcome.result).toBe(42);
    expect(outcome.logs).toEqual(["[log] hello"]);
  });

  it("matches out-of-order responses back to the right request", async () => {
    const c = makeClient();
    const order: string[] = [];
    // The slow request is sent FIRST; the server answers the fast one first,
    // so correct results here prove id-based matching, not arrival order.
    const slow = c
      .execute('await new Promise((r) => setTimeout(r, 300)); return "slow";')
      .then((o) => {
        order.push("slow");
        return o.result;
      });
    const fast = c.execute('return "fast";').then((o) => {
      order.push("fast");
      return o.result;
    });
    const [slowResult, fastResult] = await Promise.all([slow, fast]);
    expect(slowResult).toBe("slow");
    expect(fastResult).toBe("fast");
    expect(order).toEqual(["fast", "slow"]);
  });

  it("surfaces tool errors (isError) as rejected promises", async () => {
    const c = makeClient();
    await expect(c.execute('throw new Error("boom");')).rejects.toThrow("boom");
    // The connection survives a failed run.
    const after = await c.execute("return 'still alive';");
    expect(after.result).toBe("still alive");
  });

  it("respawns the subprocess after it dies", async () => {
    // A one-shot fake server: answers a single request with its own pid, then
    // exits — so two successful calls returning different pids prove restart.
    const oneShot = `
      let buffer = "";
      const line = await new Promise((resolve) => {
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          const nl = buffer.indexOf("\\n");
          if (nl !== -1) resolve(buffer.slice(0, nl));
        });
      });
      const request = JSON.parse(line);
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: "{}" }],
          structuredContent: { result: process.pid, logs: [] },
        },
      }));
      process.exit(0);
    `;
    client = new AdminClient({ cmd: ["bun", "-e", oneShot] });
    const first = await client.execute("return null;");
    // Give the exit a moment to be observed before the next request.
    await Bun.sleep(100);
    const second = await client.execute("return null;");
    expect(typeof first.result).toBe("number");
    expect(typeof second.result).toBe("number");
    expect(first.result).not.toBe(second.result);
  });

  it("rejects in-flight requests when the subprocess dies instead of hanging", async () => {
    client = new AdminClient({
      // A server that reads a request and exits without ever answering.
      cmd: ["bun", "-e", 'process.stdin.on("data", () => process.exit(1));'],
      timeoutMs: 5_000,
    });
    await expect(client.execute("return 1;")).rejects.toThrow("exited");
  });
});
