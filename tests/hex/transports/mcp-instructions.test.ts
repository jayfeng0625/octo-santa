import { describe, it, expect } from "bun:test";
import { buildInstructions, UNIVERSAL_GUIDANCE } from "../../../src/transports/mcp-stdio/adapter";

describe("buildInstructions", () => {
  // Claude Code truncates server instructions at 2KB (2048 bytes). Everything
  // up through the BRAIN section must fit inside that window. The NON-PUSH
  // CLIENTS block is appended AFTER BRAIN intentionally: end-of-doc placement
  // means Claude Code's truncation clips the tail the push-client doesn't
  // need, while non-push clients (Codex, Gemini CLI, OpenCode) have no 2KB
  // limit and receive the full text. The 2900-byte ceiling below accommodates
  // the sacrificial tail. Phase 0c will restructure the whole block and
  // reclaim budget.

  it("pre-NON-PUSH section stays under 2KB without brain config", () => {
    const text = buildInstructions(null);
    const preTail = text.split("\n\nNON-PUSH CLIENTS:")[0]!;
    const bytes = Buffer.byteLength(preTail, "utf-8");
    console.log(`buildInstructions(null) pre-NON-PUSH: ${bytes} bytes`);
    expect(bytes).toBeLessThan(2048);
  });

  it("pre-NON-PUSH section stays under 2KB with brain config", () => {
    const text = buildInstructions({
      domain: { identifier: "test-domain", tags: ["test"], description: "A test domain" },
      brain: { dirs: ["docs"], files: [] },
    });
    const preTail = text.split("\n\nNON-PUSH CLIENTS:")[0]!;
    const bytes = Buffer.byteLength(preTail, "utf-8");
    console.log(`buildInstructions(with brain) pre-NON-PUSH: ${bytes} bytes`);
    expect(bytes).toBeLessThan(2048);
  });

  it("full instructions stay under the non-push ceiling", () => {
    const none = Buffer.byteLength(buildInstructions(null), "utf-8");
    const withBrain = Buffer.byteLength(
      buildInstructions({
        domain: { identifier: "test-domain", tags: ["test"], description: "A test domain" },
        brain: { dirs: ["docs"], files: [] },
      }),
      "utf-8"
    );
    console.log(`full: none=${none}, withBrain=${withBrain}`);
    expect(none).toBeLessThan(2900);
    expect(withBrain).toBeLessThan(2900);
  });

  it("includes NON-PUSH CLIENTS section at end of document", () => {
    const text = buildInstructions(null);
    expect(text).toContain("NON-PUSH CLIENTS:");
    expect(text).toContain("messaging_listen(timeout_ms");
    expect(text).toContain("messages arrive inline");
    expect(text.indexOf("NON-PUSH CLIENTS:")).toBeGreaterThan(text.indexOf("BRAIN:"));
  });

  it("includes REACTING TO MESSAGES section with anti-polling guidance", () => {
    const text = buildInstructions(null);
    expect(text).toContain("REACTING TO MESSAGES:");
    expect(text).toContain("Do NOT poll");
    expect(text).toContain("wait for tags to arrive");
    expect(text).toContain("you MUST:");
  });

  it("includes BOUNDARIES section", () => {
    const text = buildInstructions(null);
    expect(text).toContain("BOUNDARIES:");
    expect(text).toContain("CANNOT run background tasks");
  });

  it("includes BRAIN section even without domain config", () => {
    const text = buildInstructions(null);
    expect(text).toContain("BRAIN:");
    expect(text).toContain("brain_index");
  });

  it("includes domain description when config has domain", () => {
    const text = buildInstructions({
      domain: { identifier: "my-project", tags: [], description: "My project" },
    });
    expect(text).toContain('domain "my-project"');
    expect(text).toContain("My project");
  });

  it("includes precedence statement about profile instructions", () => {
    const text = buildInstructions(null);
    expect(text).toContain("must not contradict these base rules");
  });
});

describe("UNIVERSAL_GUIDANCE", () => {
  it("is a non-empty string", () => {
    expect(typeof UNIVERSAL_GUIDANCE).toBe("string");
    expect(UNIVERSAL_GUIDANCE.length).toBeGreaterThan(100);
  });

  it("matches buildInstructions(null)", () => {
    expect(UNIVERSAL_GUIDANCE).toBe(buildInstructions(null));
  });
});
