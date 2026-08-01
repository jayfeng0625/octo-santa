import { describe, it, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { verify, MAX_WEBHOOK_AGE_MS } from "../src/verify";

const SECRET = "test-webhook-secret";
const NOW = 1_754_000_000_000;

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function body(webhookTimestamp: number = NOW): string {
  return JSON.stringify({ type: "Issue", action: "create", webhookTimestamp });
}

describe("verify", () => {
  it("accepts a correctly signed, fresh payload", () => {
    const raw = body();
    expect(verify(raw, sign(raw), SECRET, NOW)).toEqual({ ok: true, skipped: false });
  });

  it("rejects a signature computed with the wrong secret", () => {
    const raw = body();
    const result = verify(raw, sign(raw, "other-secret"), SECRET, NOW);
    expect(result.ok).toBe(false);
  });

  it("rejects when the body was tampered with after signing", () => {
    const raw = body();
    const signature = sign(raw);
    const tampered = raw.replace("create", "update");
    expect(verify(tampered, signature, SECRET, NOW).ok).toBe(false);
  });

  it("rejects a missing signature header", () => {
    const result = verify(body(), null, SECRET, NOW);
    expect(result).toEqual({ ok: false, reason: "missing linear-signature header" });
  });

  it("rejects a malformed (non-hex) signature without throwing", () => {
    expect(verify(body(), "not-hex-at-all", SECRET, NOW).ok).toBe(false);
  });

  it("rejects a payload whose webhookTimestamp is more than 60s old", () => {
    const raw = body(NOW - MAX_WEBHOOK_AGE_MS - 1);
    const result = verify(raw, sign(raw), SECRET, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("replay");
  });

  it("accepts a payload exactly at the 60s age boundary", () => {
    const raw = body(NOW - MAX_WEBHOOK_AGE_MS);
    expect(verify(raw, sign(raw), SECRET, NOW).ok).toBe(true);
  });

  it("accepts a signed payload without a webhookTimestamp (lenient on shape)", () => {
    const raw = JSON.stringify({ type: "Issue", action: "create" });
    expect(verify(raw, sign(raw), SECRET, NOW)).toEqual({ ok: true, skipped: false });
  });

  it("skips verification entirely when no secret is configured, and says so", () => {
    // Even a garbage signature passes — the skipped flag is the caller's cue
    // to warn loudly.
    expect(verify(body(), "garbage", undefined, NOW)).toEqual({ ok: true, skipped: true });
    expect(verify(body(), null, undefined, NOW)).toEqual({ ok: true, skipped: true });
  });
});
