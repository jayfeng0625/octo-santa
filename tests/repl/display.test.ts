import { describe, it, expect } from "bun:test";
import { formatMessage } from "../../src/repl";

describe("formatMessage", () => {
  it("omits channel prefix for active channel", () => {
    const msg = { agent_id: "agent-a", content: "hello" };
    expect(formatMessage(msg, "planning", "planning")).toBe("[agent-a] hello");
  });

  it("includes #channel prefix for non-active channel", () => {
    const msg = { agent_id: "agent-a", content: "deploy done" };
    expect(formatMessage(msg, "ops", "planning")).toBe("[#ops][agent-a] deploy done");
  });

  it("strips ANSI escape sequences from content", () => {
    const msg = { agent_id: "agent-a", content: "\x1b[2J\x1b[Hfake prompt>" };
    expect(formatMessage(msg, "ch", "ch")).toBe("[agent-a] fake prompt>");
  });

  it("strips carriage returns", () => {
    const msg = { agent_id: "agent-a", content: "real\roverwrite" };
    expect(formatMessage(msg, "ch", "ch")).toBe("[agent-a] realoverwrite");
  });

  it("preserves newlines in multiline messages", () => {
    const msg = { agent_id: "agent-a", content: "line1\nline2" };
    expect(formatMessage(msg, "ch", "ch")).toBe("[agent-a] line1\nline2");
  });

  it("strips control chars from agent_id", () => {
    const msg = { agent_id: "agent\x1b[31m-evil", content: "hi" };
    expect(formatMessage(msg, "ch", "ch")).toBe("[agent-evil] hi");
  });
});
