import { describe, it, expect } from "bun:test";
import { parseArgs } from "../../src/repl/args";

describe("parseArgs", () => {
  it("parses REPL mode args", () => {
    const args = parseArgs(["bun", "repl.ts", "--as", "jay", "-c", "planning"]);
    expect(args).toEqual({ mode: "repl", agentId: "jay", channel: "planning" });
  });

  it("parses send mode with -f", () => {
    const args = parseArgs(["bun", "repl.ts", "send", "--as", "jay", "-c", "planning", "-f", "brief.md"]);
    expect(args).toEqual({ mode: "send", agentId: "jay", channel: "planning", filePath: "brief.md" });
  });

  it("parses send mode without -f (stdin)", () => {
    const args = parseArgs(["bun", "repl.ts", "send", "--as", "jay", "-c", "planning"]);
    expect(args).toEqual({ mode: "send", agentId: "jay", channel: "planning" });
  });

  it("throws when --as is missing", () => {
    expect(() => parseArgs(["bun", "repl.ts", "-c", "planning"])).toThrow("--as");
  });

  it("throws when -c is missing", () => {
    expect(() => parseArgs(["bun", "repl.ts", "--as", "jay"])).toThrow("-c");
  });

  it("throws on invalid --as name (spaces)", () => {
    expect(() => parseArgs(["bun", "repl.ts", "--as", "bad name", "-c", "ch"])).toThrow("must match");
  });

  it("rejects reserved name 'all'", () => {
    expect(() => parseArgs(["bun", "repl.ts", "--as", "all", "-c", "ch"])).toThrow("reserved");
  });

  it("rejects reserved name 'here'", () => {
    expect(() => parseArgs(["bun", "repl.ts", "--as", "here", "-c", "ch"])).toThrow("reserved");
  });
});
