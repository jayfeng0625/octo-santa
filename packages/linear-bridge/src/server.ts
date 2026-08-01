import { verify } from "./verify";
import { translate } from "./translate";

// Anything with execute() will do — tests inject fakes, main.ts injects the
// real AdminClient. Delivery is one admin_execute call so channel creation
// and send happen in a single round trip to the admin server.
export interface AdminExecutor {
  execute(code: string): Promise<{ result: unknown; logs: string[] }>;
}

export interface BridgeServerOptions {
  client: AdminExecutor;
  // port 0 = OS-assigned (tests). Defaults fall back to env, then constants.
  port?: number;
  channel?: string;
  sender?: string;
  webhookSecret?: string;
  // Injectable clock for deterministic replay-guard tests.
  now?: () => number;
}

export function createBridgeServer(options: BridgeServerOptions) {
  const channel = options.channel ?? process.env.OCTO_SANTA_BRIDGE_CHANNEL ?? "linear";
  const sender = options.sender ?? process.env.OCTO_SANTA_BRIDGE_SENDER ?? "linear-bridge";
  const secret = options.webhookSecret ?? process.env.LINEAR_WEBHOOK_SECRET;
  const now = options.now ?? Date.now;

  if (!secret) {
    console.warn(
      "[linear-bridge] LINEAR_WEBHOOK_SECRET is not set — webhook signature " +
        "verification is DISABLED. Anyone who can reach this port can inject " +
        "messages. Prototype convenience only."
    );
  }

  async function handleWebhook(req: Request): Promise<Response> {
    // The raw text is what Linear signed — read it before any parsing.
    const rawBody = await req.text();
    const verdict = verify(rawBody, req.headers.get("linear-signature"), secret, now());
    if (!verdict.ok) {
      return Response.json({ ok: false, error: verdict.reason }, { status: 401 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return Response.json({ ok: false, error: "body is not JSON" }, { status: 400 });
    }

    const message = translate(payload);
    if (message === null) {
      // 200, not an error status: Linear retries non-2xx responses, and an
      // event type we deliberately ignore should not retry-loop.
      return Response.json({ ok: true, ignored: true });
    }

    // Values are injected via JSON.stringify, never string interpolation, so
    // webhook-controlled content (titles, comment bodies) cannot escape into
    // the executed code.
    const params = { channel, sender, content: message.content, mentions: message.mentions };
    const code = [
      `const p = ${JSON.stringify(params)};`,
      "storage.createChannelIfMissing(p.channel, p.sender);",
      "const sent = storage.sendMessage(p);",
      "return sent.id;",
    ].join("\n");

    try {
      const outcome = await options.client.execute(code);
      return Response.json({ ok: true, delivered: outcome.result });
    } catch (error) {
      console.error(`[linear-bridge] delivery failed: ${error}`);
      // Non-2xx on real delivery failure so Linear's retries get another shot.
      return Response.json({ ok: false, error: "delivery failed" }, { status: 502 });
    }
  }

  return Bun.serve({
    port: options.port ?? (Number(process.env.OCTO_SANTA_BRIDGE_PORT ?? "") || 8787),
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/healthz") {
        return Response.json({ ok: true });
      }
      if (req.method === "POST" && path === "/webhooks/linear") {
        return handleWebhook(req);
      }
      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    },
  });
}
