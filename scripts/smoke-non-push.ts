// Non-push MCP client smoke test. Spawns two real MCP stdio server processes
// sharing a temp SQLite DB and drives them as a non-push client would — using
// messaging_listen in place of pushed <channel> tags — to verify the
// inline-delivery listen-poll flow end to end.
//
// Run: bun run scripts/smoke-non-push.ts

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";

function log(step: string, msg: string): void {
  console.log(`[${step}] ${msg}`);
}

async function connect(clientName: string, dbPath: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", "src/main.ts"],
    env: {
      ...(process.env as Record<string, string>),
      OCTO_SANTA_DB: dbPath,
    },
  });
  const client = new Client(
    { name: clientName, version: "0.0.0-smoke" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return client;
}

async function callJson<T = unknown>(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text?: string }> | undefined;
  const text = content?.[0]?.text ?? "{}";
  if (res.isError) {
    throw new Error(`${name} tool error: ${text}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`${name} response not JSON: ${text.slice(0, 200)}`);
  }
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "octo-santa-smoke-"));
  const dbPath = join(tmp, "messages.db");
  log("version", `octo-santa ${pkg.version} (db: ${dbPath})`);

  let tester: Client | null = null;
  let sender: Client | null = null;
  try {
    tester = await connect("smoke-tester", dbPath);
    sender = await connect("smoke-sender", dbPath);

    // Confirm the server instructions text advertises the non-push loop.
    const instr = tester.getInstructions() ?? "";
    const bytes = Buffer.byteLength(instr, "utf-8");
    if (!instr.includes("NON-PUSH CLIENTS")) {
      throw new Error(
        `instructions missing NON-PUSH CLIENTS block (got ${bytes} B)`
      );
    }
    log("instructions", `${bytes} B, NON-PUSH CLIENTS block present`);

    // Step 1: register
    const reg = await callJson<{ id: string }>(
      tester,
      "messaging_register",
      { agent_id: "os-listen-tester" }
    );
    log("step1", `registered as ${reg.id}`);

    await callJson(sender, "messaging_register", { agent_id: "os-listen-sender" });

    // Step 2: subscribe to test channel (sender creates, tester subscribes)
    await callJson(sender, "messaging_create_channel", {
      agent_id: "os-listen-sender",
      name: "smoke-listen",
    });
    await callJson(tester, "messaging_subscribe", {
      agent_id: "os-listen-tester",
      channel: "smoke-listen",
    });
    log("step2", "subscribed os-listen-tester to smoke-listen");

    // Step 3: listen with no traffic → timed_out
    const t0 = Date.now();
    const idle = await callJson<{ channels: unknown[]; timed_out: boolean }>(
      tester,
      "messaging_listen",
      { agent_id: "os-listen-tester", timeout_ms: 5000 }
    );
    const idleDt = Date.now() - t0;
    if (!idle.timed_out || idle.channels.length !== 0) {
      throw new Error(
        `step3 expected timed_out:true, channels:[]; got ${JSON.stringify(idle)}`
      );
    }
    log("step3", `listen timed out after ${idleDt}ms, channels=[]`);

    // Step 4: sender sends a message to the channel
    const sent = await callJson<{ id: number }>(sender, "messaging_send", {
      agent_id: "os-listen-sender",
      channel: "smoke-listen",
      content: "hello from non-push smoke test @os-listen-tester",
    });
    log("step4", `sender posted message id=${sent.id}`);

    // Step 5a: listen again → channel entry with the message inline (no
    // separate messaging_read_messages call needed).
    const t1 = Date.now();
    const hit = await callJson<{
      channels: Array<{ channel: string; messages: Array<{ id: number; content: string }> }>;
      timed_out: boolean;
    }>(tester, "messaging_listen", { agent_id: "os-listen-tester", timeout_ms: 5000 });
    const hitDt = Date.now() - t1;
    const smoke = hit.channels.find((c) => c.channel === "smoke-listen");
    if (hit.timed_out || !smoke) {
      throw new Error(
        `step5 expected smoke-listen in channels; got ${JSON.stringify(hit)}`
      );
    }
    const inline = smoke.messages ?? [];
    if (inline.length === 0 || inline[0]!.id !== sent.id) {
      throw new Error(
        `step5 expected inline message id=${sent.id}; got ${JSON.stringify(inline)}`
      );
    }
    log(
      "step5a",
      `listen returned after ${hitDt}ms: inline ${inline.length} message(s) on smoke-listen (id=${inline[0]!.id})`
    );

    // Step 5b: cursor-advance proof — subsequent listen must time out because
    // the previous listen already consumed the unread batch.
    const t2 = Date.now();
    const drained = await callJson<{ channels: unknown[]; timed_out: boolean }>(
      tester,
      "messaging_listen",
      { agent_id: "os-listen-tester", timeout_ms: 3000 }
    );
    const drainDt = Date.now() - t2;
    if (!drained.timed_out || drained.channels.length !== 0) {
      throw new Error(
        `step5b expected timed_out:true, channels:[] (cursor should have advanced); got ${JSON.stringify(drained)}`
      );
    }
    log(
      "step5b",
      `cursor proof: follow-up listen timed out after ${drainDt}ms (inline batch not re-served)`
    );

    console.log("\n✓ non-push smoke test passed");
  } finally {
    await tester?.close().catch(() => {});
    await sender?.close().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("✗ non-push smoke test failed:", err);
  process.exit(1);
});
