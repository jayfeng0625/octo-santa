import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { TextInput } from "../../src/repl/components/text-input";

// Allow React effects (useEffect in useInput) to fire before interacting with stdin.
// ink-testing-library's stdin flows through: readable event → inputParser → internal_eventEmitter → useInput,
// but the readable listener is only attached after useInput's setRawMode(true) effect runs.
// A small delay (10ms) is used instead of setTimeout(0) to avoid flakiness when many test files
// run in parallel and the event loop is contended.
const tick = () => new Promise((r) => setTimeout(r, 10));

describe("TextInput", () => {
  it("renders prompt with channel name", () => {
    const { lastFrame } = render(
      <TextInput prompt="general" onSubmit={() => {}} />
    );
    expect(lastFrame()).toContain("general>");
  });

  it("captures typed characters", async () => {
    const { lastFrame, stdin } = render(
      <TextInput prompt="general" onSubmit={() => {}} />
    );
    await tick();
    stdin.write("hello");
    await tick();
    expect(lastFrame()).toContain("hello");
  });

  it("submits on Enter and clears input", async () => {
    let submitted = "";
    const { lastFrame, stdin } = render(
      <TextInput prompt="general" onSubmit={(v) => { submitted = v; }} />
    );
    await tick();
    stdin.write("hello");
    await tick();
    stdin.write("\r");
    await tick();
    expect(submitted).toBe("hello");
    expect(lastFrame()).not.toContain("hello");
  });

  it("does not submit empty input", async () => {
    let called = false;
    const { stdin } = render(
      <TextInput prompt="general" onSubmit={() => { called = true; }} />
    );
    await tick();
    stdin.write("\r");
    await tick();
    expect(called).toBe(false);
  });

  it("inserts newline on Shift+Enter (Kitty protocol)", async () => {
    let submitted = "";
    const { lastFrame, stdin } = render(
      <TextInput prompt="general" onSubmit={(v) => { submitted = v; }} />
    );
    await tick();
    stdin.write("line1");
    await tick();
    stdin.write("\x1b[13;2u"); // Shift+Enter in Kitty protocol
    await tick();
    stdin.write("line2");
    await tick();
    expect(lastFrame()).toContain("line1");
    expect(lastFrame()).toContain("line2");
    stdin.write("\r");
    await tick();
    expect(submitted).toBe("line1\nline2");
  });

  it("handles backspace within a line", async () => {
    const { lastFrame, stdin } = render(
      <TextInput prompt="general" onSubmit={() => {}} />
    );
    await tick();
    stdin.write("helloo");
    await tick();
    stdin.write("\x7f"); // backspace
    await tick();
    expect(lastFrame()).toContain("hello");
    expect(lastFrame()).not.toContain("helloo");
  });

  it("handles backspace across newline boundary", async () => {
    let submitted = "";
    const { stdin } = render(
      <TextInput prompt="general" onSubmit={(v) => { submitted = v; }} />
    );
    await tick();
    stdin.write("line1");
    await tick();
    stdin.write("\x1b[13;2u"); // Shift+Enter
    await tick();
    stdin.write("\x7f"); // backspace — should delete the newline
    await tick();
    stdin.write("\r");
    await tick();
    expect(submitted).toBe("line1");
  });

  it("exits on Ctrl+C", async () => {
    let exited = false;
    const { stdin } = render(
      <TextInput prompt="general" onSubmit={() => {}} onExit={() => { exited = true; }} />
    );
    await tick();
    stdin.write("\x03"); // Ctrl+C
    await tick();
    expect(exited).toBe(true);
  });

  it("moves cursor between lines with Up/Down arrows", async () => {
    let submitted = "";
    const { stdin } = render(
      <TextInput prompt="general" onSubmit={(v) => { submitted = v; }} />
    );
    await tick();
    stdin.write("line1");
    await tick();
    stdin.write("\x1b[13;2u"); // Shift+Enter → newline
    await tick();
    stdin.write("line2");
    await tick();
    stdin.write("\x1b[A"); // Up arrow — move to line 1
    await tick();
    stdin.write("X"); // Insert X in line 1
    await tick();
    stdin.write("\r");
    await tick();
    expect(submitted).toContain("X");
    expect(submitted).toContain("line2");
  });

  it("falls back to submit on Enter when no Kitty support (no regression)", async () => {
    let submitted = "";
    const { stdin } = render(
      <TextInput prompt="general" onSubmit={(v) => { submitted = v; }} />
    );
    await tick();
    stdin.write("hello");
    await tick();
    stdin.write("\r"); // Plain Enter — always submits
    await tick();
    expect(submitted).toBe("hello");
  });

  it("preserves whitespace in multiline submissions", async () => {
    let submitted = "";
    const { stdin } = render(
      <TextInput prompt="general" onSubmit={(v) => { submitted = v; }} />
    );
    await tick();
    stdin.write("  indented");
    await tick();
    stdin.write("\x1b[13;2u"); // Shift+Enter
    await tick();
    stdin.write("  also indented");
    await tick();
    stdin.write("\r");
    await tick();
    expect(submitted).toBe("  indented\n  also indented");
  });
});
