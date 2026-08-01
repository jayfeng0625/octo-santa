import { describe, it, expect } from "bun:test";
import { buildInstructions } from "../../../src/transports/mcp-stdio/adapter";

describe("buildInstructions", () => {
  // Claude Code truncates server instructions at 2KB (2048 bytes) — the full
  // text must fit inside that window.
  it("stays under 2KB", () => {
    const bytes = Buffer.byteLength(buildInstructions(), "utf-8");
    expect(bytes).toBeLessThan(2048);
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

  it("documents the resources surface: unfiltered activity pings, cursor-free reads", () => {
    const text = buildInstructions();
    expect(text).toContain("RESOURCES");
    // resources/updated is an unfiltered activity ping, unlike the mention-
    // filtered custom push.
    expect(text).toMatch(/ALL new messages/);
    expect(text).toMatch(/not just mentions/);
    // resources/read never consumes unread — cursors belong to the tool.
    expect(text).toMatch(/NEVER consumes unread/);
    expect(text).toContain("messaging_read_messages only");
  });

  it("does not reference removed features", () => {
    const text = buildInstructions();
    expect(text).not.toContain("BRAIN:");
    expect(text).not.toContain("brain_");
    expect(text).not.toContain("PROFILES:");
    expect(text).not.toContain("pool");
    expect(text).not.toContain("messaging_listen");
  });
});
