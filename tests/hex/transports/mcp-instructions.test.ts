import { describe, it, expect } from "bun:test";
import { buildInstructions, UNIVERSAL_GUIDANCE } from "../../../src/transports/mcp-stdio/adapter";

describe("buildInstructions", () => {
  // Claude Code truncates server instructions at 2KB (2048 bytes).
  // The BRAIN section adds ~50 bytes with domain. If the base text exceeds budget,
  // trim SENDING and DISCOVERY first -- REACTING TO MESSAGES and BOUNDARIES
  // are highest priority for weak models.

  it("stays under 2KB without brain config", () => {
    const text = buildInstructions(null);
    const bytes = Buffer.byteLength(text, "utf-8");
    console.log(`buildInstructions(null): ${bytes} bytes`);
    expect(bytes).toBeLessThan(2048);
  });

  it("stays under 2KB with brain config", () => {
    const text = buildInstructions({
      domain: { identifier: "test-domain", tags: ["test"], description: "A test domain" },
      brain: { dirs: ["docs"], files: [] },
    });
    const bytes = Buffer.byteLength(text, "utf-8");
    console.log(`buildInstructions(with brain): ${bytes} bytes`);
    expect(bytes).toBeLessThan(2048);
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
