import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import {
  MessageLog,
  type LogEntry,
} from "../../src/repl/components/message-log";

describe("MessageLog", () => {
  it("renders nothing when messages is empty", () => {
    const { lastFrame } = render(<MessageLog messages={[]} />);
    expect(lastFrame()).toBe("");
  });

  it("renders messages with agent prefix", () => {
    const messages: LogEntry[] = [
      { text: "[alice] hello" },
      { text: "[bob] world" },
    ];
    const { lastFrame } = render(<MessageLog messages={messages} />);
    const frame = lastFrame()!;
    expect(frame).toContain("[alice] hello");
    expect(frame).toContain("[bob] world");
  });

  it("renders system messages", () => {
    const messages: LogEntry[] = [
      { text: "Switched to #general", system: true },
    ];
    const { lastFrame } = render(<MessageLog messages={messages} />);
    expect(lastFrame()).toContain("Switched to #general");
  });

  it("renders messages with rich text tokens", () => {
    const messages: LogEntry[] = [
      { text: "[agent-a] hey @jay check #ops" },
    ];
    const { lastFrame } = render(<MessageLog messages={messages} />);
    const frame = lastFrame()!;
    expect(frame).toContain("[agent-a]");
    expect(frame).toContain("@jay");
    expect(frame).toContain("#ops");
  });

});
