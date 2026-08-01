// Full path: HTTP webhook in → signature check → translation → delivery over
// the real admin MCP subprocess → row in the shared SQLite database, verified
// back THROUGH the admin client (never by importing octo-santa's storage).
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { createHmac } from "node:crypto";
import { AdminClient } from "../src/admin-client";
import { createBridgeServer } from "../src/server";

const TEST_DB = `/tmp/linear-bridge-test-integration-${process.pid}.sqlite`;
const SECRET = "integration-test-secret";

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = path + suffix;
    if (existsSync(file)) unlinkSync(file);
  }
}

function sign(rawBody: string): string {
  return createHmac("sha256", SECRET).update(rawBody).digest("hex");
}

let client: AdminClient;
let server: ReturnType<typeof createBridgeServer>;

beforeAll(() => {
  cleanupDb(TEST_DB);
  client = new AdminClient({ env: { OCTO_SANTA_DB: TEST_DB } });
  server = createBridgeServer({ client, port: 0, webhookSecret: SECRET });
});

afterAll(async () => {
  server.stop();
  await client.close();
  cleanupDb(TEST_DB);
});

function post(rawBody: string, signature: string | undefined): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== undefined) headers["linear-signature"] = signature;
  return fetch(`http://localhost:${server.port}/webhooks/linear`, {
    method: "POST",
    headers,
    body: rawBody,
  });
}

describe("linear-bridge end to end", () => {
  it("answers healthz", async () => {
    const res = await fetch(`http://localhost:${server.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("delivers a signed issue-create webhook into the linear channel", async () => {
    const payload = {
      action: "create",
      type: "Issue",
      organizationId: "org-1",
      webhookId: "wh-1",
      webhookTimestamp: Date.now(),
      createdAt: "2026-08-01T10:00:00.000Z",
      url: "https://linear.app/acme/issue/ENG-123/fix-the-flux-capacitor",
      data: {
        id: "b3c1a9e0-0000-0000-0000-000000000000",
        identifier: "ENG-123",
        title: "Fix the flux capacitor",
        number: 123,
        teamId: "team-eng",
        state: { id: "state-1", name: "Todo", type: "unstarted" },
      },
    };
    const raw = JSON.stringify(payload);

    const res = await post(raw, sign(raw));
    expect(res.status).toBe(200);
    const outcome = (await res.json()) as { ok: boolean; delivered?: unknown };
    expect(outcome.ok).toBe(true);
    expect(typeof outcome.delivered).toBe("number");

    // Verify through the admin client that the row exists in shared storage.
    const check = await client.execute('return storage.getMessages({ channel: "linear" });');
    const rows = check.result as Array<{
      id: number;
      channel: string;
      sender: string;
      content: string;
      mentions: string[];
    }>;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(outcome.delivered as number);
    expect(row.channel).toBe("linear");
    expect(row.sender).toBe("linear-bridge");
    expect(row.mentions).toEqual(["*"]);
    expect(row.content).toBe(
      "Linear ENG-123 created: Fix the flux capacitor (Todo) " +
        "https://linear.app/acme/issue/ENG-123/fix-the-flux-capacitor"
    );
  });

  it("rejects a bad signature with 401 and delivers nothing", async () => {
    const raw = JSON.stringify({
      action: "create",
      type: "Issue",
      webhookTimestamp: Date.now(),
      data: { identifier: "ENG-999", title: "Forged" },
    });
    const res = await post(raw, "0".repeat(64));
    expect(res.status).toBe(401);

    const check = await client.execute(
      'return storage.getMessages({ channel: "linear" }).length;'
    );
    expect(check.result).toBe(1); // Still only the message from the previous test.
  });

  it("acknowledges but ignores signed events the bridge does not handle", async () => {
    const raw = JSON.stringify({
      action: "remove",
      type: "Reaction",
      webhookTimestamp: Date.now(),
      data: {},
    });
    const res = await post(raw, sign(raw));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
  });
});
