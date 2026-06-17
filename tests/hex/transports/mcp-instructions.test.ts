import { describe, it, expect } from "bun:test";
import { buildInstructions, UNIVERSAL_GUIDANCE } from "../../../src/transports/mcp-stdio/adapter";

describe("buildInstructions", () => {
  // Claude Code truncates server instructions at 2KB (2048 bytes). Everything
  // up through the messaging guidance must fit inside that window. The NON-PUSH
  // CLIENTS block is appended at the end intentionally: end-of-doc placement
  // means Claude Code's truncation clips the tail the push-client doesn't
  // need, while non-push clients (Codex, Gemini CLI, OpenCode) have no 2KB
  // limit and receive the full text. The 2900-byte ceiling below accommodates
  // the sacrificial tail.

  it("pre-NON-PUSH section stays under 2KB", () => {
    const text = buildInstructions();
    const preTail = text.split("\n\nNON-PUSH CLIENTS:")[0]!;
    const bytes = Buffer.byteLength(preTail, "utf-8");
    console.log(`buildInstructions() pre-NON-PUSH: ${bytes} bytes`);
    expect(bytes).toBeLessThan(2048);
  });

  it("full instructions stay under the non-push ceiling", () => {
    const bytes = Buffer.byteLength(buildInstructions(), "utf-8");
    console.log(`full: ${bytes}`);
    expect(bytes).toBeLessThan(2900);
  });

  it("includes NON-PUSH CLIENTS section at end of document", () => {
    const text = buildInstructions();
    expect(text).toContain("NON-PUSH CLIENTS:");
    expect(text).toContain("messaging_listen(timeout_ms");
    expect(text).toContain("messages arrive inline");
    expect(text.indexOf("NON-PUSH CLIENTS:")).toBeGreaterThan(text.indexOf("BOUNDARIES:"));
  });

  it("includes REACTING TO MESSAGES section with anti-polling guidance", () => {
    const text = buildInstructions();
    expect(text).toContain("REACTING TO MESSAGES:");
    expect(text).toContain("Do NOT poll");
    expect(text).toContain("wait for tags to arrive");
    expect(text).toContain("you MUST:");
  });

  it("includes BOUNDARIES section", () => {
    const text = buildInstructions();
    expect(text).toContain("BOUNDARIES:");
    expect(text).toContain("CANNOT run background tasks");
  });

  it("does not reference the removed brain feature", () => {
    const text = buildInstructions();
    expect(text).not.toContain("BRAIN:");
    expect(text).not.toContain("brain_");
  });

  it("includes precedence statement about profile instructions", () => {
    const text = buildInstructions();
    expect(text).toContain("must not contradict these base rules");
  });
});

describe("UNIVERSAL_GUIDANCE", () => {
  it("is a non-empty string", () => {
    expect(typeof UNIVERSAL_GUIDANCE).toBe("string");
    expect(UNIVERSAL_GUIDANCE.length).toBeGreaterThan(100);
  });

  it("matches buildInstructions()", () => {
    expect(UNIVERSAL_GUIDANCE).toBe(buildInstructions());
  });
});
