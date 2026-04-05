import { describe, it, expect } from "bun:test";
import { sanitize, formatMessage, agentColor } from "../../src/transports/repl/renderer";

describe("sanitize", () => {
  it("strips ANSI escape sequences", () => {
    expect(sanitize("\x1b[2J\x1b[Hfake prompt>")).toBe("fake prompt>");
  });

  it("strips carriage returns", () => {
    expect(sanitize("real\roverwrite")).toBe("realoverwrite");
  });

  it("preserves newlines", () => {
    expect(sanitize("line1\nline2")).toBe("line1\nline2");
  });

  it("preserves tabs", () => {
    expect(sanitize("col1\tcol2")).toBe("col1\tcol2");
  });

  it("strips other control characters", () => {
    expect(sanitize("hello\x00\x01\x02world")).toBe("helloworld");
  });
});

describe("formatMessage", () => {
  it("formats same-channel message", () => {
    const result = formatMessage(
      { agent_id: "agent-a", content: "hello" },
      "planning",
      "planning"
    );
    expect(result.plain).toBe("[agent-a] hello");
  });

  it("formats cross-channel message with prefix", () => {
    const result = formatMessage(
      { agent_id: "agent-c", content: "deploy done" },
      "ops",
      "planning"
    );
    expect(result.plain).toBe("[#ops][agent-c] deploy done");
  });

  it("indents multiline messages", () => {
    const result = formatMessage(
      { agent_id: "agent-a", content: "line1\nline2\n  indented" },
      "ch",
      "ch"
    );
    const lines = result.plain.split("\n");
    expect(lines[0]).toBe("[agent-a] line1");
    expect(lines[1]).toBe("          line2");
    expect(lines[2]).toBe("            indented");
  });

  it("sanitizes agent_id", () => {
    const result = formatMessage(
      { agent_id: "agent\x1b[31m-evil", content: "hi" },
      "ch",
      "ch"
    );
    expect(result.plain).toBe("[agent-evil] hi");
  });

  it("sanitizes content", () => {
    const result = formatMessage(
      { agent_id: "agent-a", content: "\x1b[2Jcleared" },
      "ch",
      "ch"
    );
    expect(result.plain).toBe("[agent-a] cleared");
  });
});

describe("expandTabs", () => {
  // Access via Renderer instance for testing
  it("expands tab to 4-space stops", async () => {
    const r = new (await import("../../src/transports/repl/renderer")).Renderer();
    // @ts-ignore — accessing private for test
    expect(r.expandTabs("a\tb")).toBe("a   b"); // 'a' at col 0, tab to col 4
    // @ts-ignore
    expect(r.expandTabs("ab\tc")).toBe("ab  c"); // 'ab' at col 0-1, tab to col 4
    // @ts-ignore
    expect(r.expandTabs("abcd\te")).toBe("abcd    e"); // 'abcd' at col 0-3, tab to col 8
  });
});

describe("agentColor", () => {
  it("returns consistent color for same agent", () => {
    const c1 = agentColor("agent-a");
    const c2 = agentColor("agent-a");
    expect(c1).toBe(c2);
  });

  it("returns different colors for different agents", () => {
    const c1 = agentColor("agent-a");
    const c2 = agentColor("agent-b");
    expect(c1).not.toBe(c2);
  });
});
