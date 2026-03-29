// tests/repl/rich-text.test.tsx

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { tokenize, RichText } from "../../src/repl/components/rich-text";

describe("tokenize", () => {
  it("returns plain text as a single segment", () => {
    const result = tokenize("hello world");
    expect(result).toEqual([{ text: "hello world" }]);
  });

  it("extracts @mentions", () => {
    const result = tokenize("hey @jay check this");
    expect(result).toEqual([
      { text: "hey " },
      { text: "@jay", style: "mention" },
      { text: " check this" },
    ]);
  });

  it("extracts #channels", () => {
    const result = tokenize("see #planning for details");
    expect(result).toEqual([
      { text: "see " },
      { text: "#planning", style: "channel" },
      { text: " for details" },
    ]);
  });

  it("extracts inline code", () => {
    const result = tokenize("run `bun test` now");
    expect(result).toEqual([
      { text: "run " },
      { text: "`bun test`", style: "code" },
      { text: " now" },
    ]);
  });

  it("extracts **bold**", () => {
    const result = tokenize("this is **important** stuff");
    expect(result).toEqual([
      { text: "this is " },
      { text: "**important**", style: "bold" },
      { text: " stuff" },
    ]);
  });

  it("extracts *italic*", () => {
    const result = tokenize("this is *subtle* stuff");
    expect(result).toEqual([
      { text: "this is " },
      { text: "*subtle*", style: "italic" },
      { text: " stuff" },
    ]);
  });

  it("extracts [agent-id] prefix at start", () => {
    const result = tokenize("[agent-a] hello");
    expect(result).toEqual([
      { text: "[agent-a]", style: "agent" },
      { text: " hello" },
    ]);
  });

  it("extracts [#channel] prefix at start", () => {
    const result = tokenize("[#ops][agent-b] deploy done");
    expect(result).toEqual([
      { text: "[#ops]", style: "channelPrefix" },
      { text: "[agent-b]", style: "agent" },
      { text: " deploy done" },
    ]);
  });

  it("does not match [brackets] mid-text as agent prefix", () => {
    const result = tokenize("see [this] for info");
    expect(result).toEqual([{ text: "see [this] for info" }]);
  });

  it("handles multiple tokens in one string", () => {
    const result = tokenize("@jay check #ops for `status`");
    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({ text: "@jay", style: "mention" });
    expect(result[2]).toEqual({ text: "#ops", style: "channel" });
    expect(result[4]).toEqual({ text: "`status`", style: "code" });
  });

  it("bold takes priority over italic for **double stars**", () => {
    const result = tokenize("**bold not italic**");
    expect(result).toEqual([{ text: "**bold not italic**", style: "bold" }]);
  });
});

describe("RichText", () => {
  it("renders plain text without styling", () => {
    const { lastFrame } = render(<RichText text="hello world" />);
    expect(lastFrame()).toBe("hello world");
  });

  it("renders @mentions in text", () => {
    const { lastFrame } = render(<RichText text="hey @jay" />);
    const frame = lastFrame()!;
    expect(frame).toContain("@jay");
    expect(frame).toContain("hey");
  });

  it("renders multiple token types", () => {
    const { lastFrame } = render(<RichText text="[agent-a] hello @jay in #ops" />);
    const frame = lastFrame()!;
    expect(frame).toContain("[agent-a]");
    expect(frame).toContain("@jay");
    expect(frame).toContain("#ops");
  });
});
