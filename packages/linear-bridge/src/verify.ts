import { createHmac, timingSafeEqual } from "node:crypto";

// Linear signs the RAW request body: linear-signature = hex(HMAC-SHA256(body)).
// Verify against the raw text, never a re-serialized parse — key order or
// whitespace differences would break the MAC.

export const MAX_WEBHOOK_AGE_MS = 60_000;

export type VerifyResult =
  // skipped=true means no secret was configured, so nothing was actually
  // checked — the caller must surface that loudly (prototype convenience).
  | { ok: true; skipped: boolean }
  | { ok: false; reason: string };

export function verify(
  rawBody: string,
  signature: string | null | undefined,
  secret: string | undefined,
  nowMs: number
): VerifyResult {
  if (!secret) return { ok: true, skipped: true };
  if (!signature) return { ok: false, reason: "missing linear-signature header" };

  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(signature, "hex");
  // Buffer.from(_, "hex") silently truncates at the first invalid character,
  // so a length check also catches malformed hex — and timingSafeEqual
  // requires equal lengths anyway.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "signature mismatch" };
  }

  // Replay guard: a captured request stays valid forever otherwise, since the
  // signature has no expiry of its own. Only enforced when the payload carries
  // the timestamp — Linear always sends it, but this stays lenient on shape.
  const timestamp = extractWebhookTimestamp(rawBody);
  if (timestamp !== undefined && nowMs - timestamp > MAX_WEBHOOK_AGE_MS) {
    return { ok: false, reason: "webhookTimestamp too old (possible replay)" };
  }

  return { ok: true, skipped: false };
}

function extractWebhookTimestamp(rawBody: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed === "object" && parsed !== null) {
      const value = (parsed as Record<string, unknown>).webhookTimestamp;
      if (typeof value === "number") return value;
    }
  } catch {
    // Unparseable bodies fail later at translation; the MAC already passed.
  }
  return undefined;
}
