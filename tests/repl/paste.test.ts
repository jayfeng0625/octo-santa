// tests/repl/paste.test.ts
import { describe, it, expect } from "bun:test";
import { PassThrough } from "node:stream";
import * as readline from "node:readline";
import { PasteAwareStream, handleLine, handleSigint } from "../../src/repl";

/** Collect all data pushed by the stream into a string array (one entry per push). */
function collect(stream: PasteAwareStream): string[] {
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf-8")));
  return chunks;
}

describe("PasteAwareStream", () => {
  it("passes data through unchanged when no paste markers", () => {
    const source = new PassThrough();
    const stream = new PasteAwareStream(source as any);
    const chunks = collect(stream);
    source.write("hello world");
    expect(chunks).toEqual(["hello world"]);
    expect(stream.isPasting).toBe(false);
  });

  it("strips paste start marker from output", () => {
    const source = new PassThrough();
    const stream = new PasteAwareStream(source as any);
    const chunks = collect(stream);
    source.write("\x1b[200~hello");
    // Content is buffered during paste, not pushed yet
    expect(chunks).toEqual([]);
    expect(stream.isPasting).toBe(true);
    expect(stream.pasteSeen).toBe(true);
  });

  it("buffers content during paste and pushes on paste end", () => {
    const source = new PassThrough();
    const stream = new PasteAwareStream(source as any);
    const chunks = collect(stream);
    source.write("\x1b[200~line1\nline2\x1b[201~");
    expect(chunks).toEqual(["line1\nline2"]);
    expect(stream.isPasting).toBe(false);
    expect(stream.pasteSeen).toBe(true);
  });

  it("handles start and end in same chunk (single-line paste)", () => {
    const source = new PassThrough();
    const stream = new PasteAwareStream(source as any);
    const chunks = collect(stream);
    source.write("\x1b[200~hello\x1b[201~");
    expect(chunks).toEqual(["hello"]);
    expect(stream.isPasting).toBe(false);
    expect(stream.pasteSeen).toBe(true);
  });

  it("handles paste spanning multiple chunks", () => {
    const source = new PassThrough();
    const stream = new PasteAwareStream(source as any);
    const chunks = collect(stream);
    source.write("\x1b[200~line1\n");
    expect(chunks).toEqual([]);
    expect(stream.isPasting).toBe(true);
    source.write("line2\x1b[201~");
    expect(chunks).toEqual(["line1\nline2"]);
    expect(stream.isPasting).toBe(false);
  });

  it("pushes content before paste start immediately", () => {
    const source = new PassThrough();
    const stream = new PasteAwareStream(source as any);
    const chunks = collect(stream);
    source.write("before\x1b[200~inside\x1b[201~");
    expect(chunks).toEqual(["before", "inside"]);
  });

  it("pushes content after paste end immediately", () => {
    const source = new PassThrough();
    const stream = new PasteAwareStream(source as any);
    const chunks = collect(stream);
    source.write("\x1b[200~inside\x1b[201~after");
    expect(chunks).toEqual(["inside", "after"]);
  });

  it("empty paste produces no push", () => {
    const source = new PassThrough();
    const stream = new PasteAwareStream(source as any);
    const chunks = collect(stream);
    source.write("\x1b[200~\x1b[201~");
    expect(chunks).toEqual([]);
    expect(stream.pasteSeen).toBe(true);
  });

  it("isPasting is true during push (synchronous timing)", () => {
    const source = new PassThrough();
    const stream = new PasteAwareStream(source as any);
    let isPastingDuringPush: boolean | undefined;
    stream.on("data", () => {
      isPastingDuringPush = stream.isPasting;
    });
    source.write("\x1b[200~content\x1b[201~");
    expect(isPastingDuringPush).toBe(true);
    expect(stream.isPasting).toBe(false); // after push completes
  });

  it("proxies isTTY from source", () => {
    const source = new PassThrough() as any;
    source.isTTY = true;
    const stream = new PasteAwareStream(source);
    expect(stream.isTTY).toBe(true);
  });

  it("proxies isTTY false when source is not TTY", () => {
    const source = new PassThrough();
    const stream = new PasteAwareStream(source as any);
    expect(stream.isTTY).toBe(false);
  });

  it("_destroy removes source listeners", () => {
    const source = new PassThrough();
    const before = source.listenerCount("data");
    const stream = new PasteAwareStream(source as any);
    expect(source.listenerCount("data")).toBe(before + 1);
    stream.destroy();
    expect(source.listenerCount("data")).toBe(before);
  });

  it("reset() during active paste enters discard mode — swallows until PASTE_END", () => {
    const source = new PassThrough();
    const stream = new PasteAwareStream(source as any);
    const chunks = collect(stream);
    // Start a multi-chunk paste
    source.write("\x1b[200~first chunk");
    expect(stream.isPasting).toBe(true);
    // Cancel mid-paste
    stream.reset();
    expect(stream.isPasting).toBe(false);
    // Remaining paste data + end marker arrives — should be swallowed
    source.write("more data\x1b[201~after");
    expect(chunks).toEqual(["after"]); // only "after" passes through
  });

  it("reset() clears all paste state", () => {
    const source = new PassThrough();
    const stream = new PasteAwareStream(source as any);
    source.write("\x1b[200~partial");
    expect(stream.isPasting).toBe(true);
    expect(stream.pasteSeen).toBe(true);
    stream.reset();
    expect(stream.isPasting).toBe(false);
    expect(stream.pasteSeen).toBe(false);
  });

  it("readline integration: isPasting is true when line events fire during push", () => {
    const source = new PassThrough();
    const stream = new PasteAwareStream(source as any);
    const rl = readline.createInterface({ input: stream, output: new PassThrough(), terminal: false });
    const observations: { line: string; isPasting: boolean }[] = [];
    rl.on("line", (line) => observations.push({ line, isPasting: stream.isPasting }));
    source.write("\x1b[200~line1\nline2\n\x1b[201~");
    expect(observations).toEqual([
      { line: "line1", isPasting: true },
      { line: "line2", isPasting: true },
    ]);
    rl.close();
  });

  it("repeated paste resets stream internal buffer", () => {
    const source = new PassThrough();
    const stream = new PasteAwareStream(source as any);
    const chunks = collect(stream);
    // First paste start (not ended)
    source.write("\x1b[200~first");
    expect(stream.isPasting).toBe(true);
    // Second paste start in new chunk — resets internal buffer
    source.write("\x1b[201~\x1b[200~second\x1b[201~");
    // "first" was pushed when first paste ended, "second" pushed when second ended
    expect(chunks).toEqual(["first", "second"]);
  });
});

describe("handleLine", () => {
  it("buffers lines while isPasting is true", () => {
    const stream = { isPasting: true, pasteSeen: true };
    const buf: string[] = [];
    const result = handleLine(stream, buf, "line one");
    expect(result).toEqual({ action: "buffer" });
    expect(buf).toEqual(["line one"]);
  });

  it("sends buffered content on Enter after paste ends (trailing newline)", () => {
    const stream = { isPasting: false, pasteSeen: true };
    const buf = ["line one", "line two"];
    const result = handleLine(stream, buf, "");
    expect(result).toEqual({ action: "send", content: "line one\nline two" });
    expect(buf).toEqual([]);
    expect(stream.pasteSeen).toBe(false);
  });

  it("appends non-empty confirming line before sending (no trailing newline)", () => {
    const stream = { isPasting: false, pasteSeen: true };
    const buf = ["line one"];
    const result = handleLine(stream, buf, "line two");
    expect(result).toEqual({ action: "send", content: "line one\nline two" });
    expect(buf).toEqual([]);
  });

  it("sends single-line paste on Enter (pasteSeen, empty buffer)", () => {
    const stream = { isPasting: false, pasteSeen: true };
    const buf: string[] = [];
    const result = handleLine(stream, buf, "hello");
    expect(result).toEqual({ action: "send", content: "hello" });
    expect(stream.pasteSeen).toBe(false);
  });

  it("passes through normal typed input", () => {
    const stream = { isPasting: false, pasteSeen: false };
    const buf: string[] = [];
    const result = handleLine(stream, buf, "hello world");
    expect(result).toEqual({ action: "passthrough", line: "hello world" });
  });

  it("does not interpret slash commands while isPasting", () => {
    const stream = { isPasting: true, pasteSeen: true };
    const buf: string[] = [];
    handleLine(stream, buf, "/help");
    expect(buf).toEqual(["/help"]);
  });

  it("does not interpret slash commands in pending paste (pasteSeen)", () => {
    const stream = { isPasting: false, pasteSeen: true };
    const buf = ["/help", "text"];
    const result = handleLine(stream, buf, "");
    expect(result).toEqual({ action: "send", content: "/help\ntext" });
  });

  it("passes through empty line when no paste pending", () => {
    const stream = { isPasting: false, pasteSeen: false };
    const buf: string[] = [];
    const result = handleLine(stream, buf, "");
    expect(result).toEqual({ action: "passthrough", line: "" });
  });

  it("empty paste followed by Enter is a no-op (passthrough)", () => {
    const stream = { isPasting: false, pasteSeen: true };
    const buf: string[] = [];
    const result = handleLine(stream, buf, "");
    expect(result).toEqual({ action: "passthrough", line: "" });
    expect(stream.pasteSeen).toBe(false);
  });

  it("repeated paste appends to existing buffer", () => {
    const stream = { isPasting: true, pasteSeen: true };
    const buf: string[] = [];
    // First paste lines
    handleLine(stream, buf, "from paste 1");
    // Simulate paste end + new paste start (isPasting stays true across push boundaries)
    handleLine(stream, buf, "from paste 2");
    expect(buf).toEqual(["from paste 1", "from paste 2"]);
  });

  it("preserves whitespace in pasted content (no trim)", () => {
    const stream = { isPasting: false, pasteSeen: true };
    const buf = ["  indented", "    more indented"];
    const result = handleLine(stream, buf, "");
    expect(result).toEqual({ action: "send", content: "  indented\n    more indented" });
  });

  it("send action returns raw content (caller responsible for sanitizing echo)", () => {
    const stream = { isPasting: false, pasteSeen: true };
    const buf = ["line with \x1b[31mANSI\x1b[0m codes"];
    const result = handleLine(stream, buf, "");
    // Content is returned raw — caller uses sanitize() for echo
    expect(result).toEqual({ action: "send", content: "line with \x1b[31mANSI\x1b[0m codes" });
  });

  it("preserves blank lines in pasted content", () => {
    const stream = { isPasting: false, pasteSeen: true };
    const buf = ["line1", "", "line3"];
    const result = handleLine(stream, buf, "");
    expect(result).toEqual({ action: "send", content: "line1\n\nline3" });
  });
});

describe("handleSigint", () => {
  it("discards paste buffer and returns true when paste pending", () => {
    const stream = { isPasting: false, pasteSeen: true };
    const buf = ["line one", "line two"];
    expect(handleSigint(stream, buf)).toBe(true);
    expect(buf).toEqual([]);
    expect(stream.pasteSeen).toBe(false);
  });

  it("discards during active paste (isPasting true) and calls reset", () => {
    let resetCalled = false;
    const stream = { isPasting: true, pasteSeen: true, reset: () => { resetCalled = true; } };
    const buf = ["partial"];
    expect(handleSigint(stream, buf)).toBe(true);
    expect(buf).toEqual([]);
    expect(stream.pasteSeen).toBe(false);
    expect(resetCalled).toBe(true);
  });

  it("cancels single-line paste (pasteSeen true, buffer empty)", () => {
    const stream = { isPasting: false, pasteSeen: true };
    const buf: string[] = [];
    expect(handleSigint(stream, buf)).toBe(true);
    expect(stream.pasteSeen).toBe(false);
  });

  it("returns false when no paste active", () => {
    const stream = { isPasting: false, pasteSeen: false };
    const buf: string[] = [];
    expect(handleSigint(stream, buf)).toBe(false);
  });
});
