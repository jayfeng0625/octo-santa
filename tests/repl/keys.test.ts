import { describe, it, expect } from "bun:test";
import { KeyParser, type Action } from "../../src/transports/repl/keys";

describe("KeyParser", () => {
  describe("printable characters", () => {
    it("emits insert for ASCII text", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const actions = parser.parse(Buffer.from("hello"));
      expect(actions).toEqual([{ type: "insert", text: "hello" }]);
    });
  });

  describe("control characters", () => {
    it("emits exit for Ctrl+C", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const actions = parser.parse(Buffer.from([0x03]));
      expect(actions).toEqual([{ type: "exit" }]);
    });

    it("emits submit for Enter", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const actions = parser.parse(Buffer.from([0x0d]));
      expect(actions).toEqual([{ type: "submit" }]);
    });

    it("emits backspace for 0x7f", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const actions = parser.parse(Buffer.from([0x7f]));
      expect(actions).toEqual([{ type: "backspace" }]);
    });

    it("emits deleteWord for Ctrl+W", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const actions = parser.parse(Buffer.from([0x17]));
      expect(actions).toEqual([{ type: "deleteWord" }]);
    });

    it("emits deleteToStart for Ctrl+U", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const actions = parser.parse(Buffer.from([0x15]));
      expect(actions).toEqual([{ type: "deleteToStart" }]);
    });

    it("emits deleteToEnd for Ctrl+K", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const actions = parser.parse(Buffer.from([0x0b]));
      expect(actions).toEqual([{ type: "deleteToEnd" }]);
    });

    it("emits home for Ctrl+A", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const actions = parser.parse(Buffer.from([0x01]));
      expect(actions).toEqual([{ type: "move", dir: "home" }]);
    });

    it("emits end for Ctrl+E", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const actions = parser.parse(Buffer.from([0x05]));
      expect(actions).toEqual([{ type: "move", dir: "end" }]);
    });
  });

  describe("CSI sequences", () => {
    it("emits move left for \\x1b[D", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const actions = parser.parse(Buffer.from("\x1b[D"));
      expect(actions).toEqual([{ type: "move", dir: "left" }]);
    });

    it("emits move right for \\x1b[C", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const actions = parser.parse(Buffer.from("\x1b[C"));
      expect(actions).toEqual([{ type: "move", dir: "right" }]);
    });

    it("emits move up for \\x1b[A", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const actions = parser.parse(Buffer.from("\x1b[A"));
      expect(actions).toEqual([{ type: "move", dir: "up" }]);
    });

    it("emits move down for \\x1b[B", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const actions = parser.parse(Buffer.from("\x1b[B"));
      expect(actions).toEqual([{ type: "move", dir: "down" }]);
    });

    it("emits wordLeft for Alt+Left (\\x1b[1;3D)", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const actions = parser.parse(Buffer.from("\x1b[1;3D"));
      expect(actions).toEqual([{ type: "move", dir: "wordLeft" }]);
    });

    it("emits wordRight for Alt+Right (\\x1b[1;3C)", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const actions = parser.parse(Buffer.from("\x1b[1;3C"));
      expect(actions).toEqual([{ type: "move", dir: "wordRight" }]);
    });

    it("emits home for Home key (\\x1b[H)", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const actions = parser.parse(Buffer.from("\x1b[H"));
      expect(actions).toEqual([{ type: "move", dir: "home" }]);
    });

    it("emits end for End key (\\x1b[F)", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const actions = parser.parse(Buffer.from("\x1b[F"));
      expect(actions).toEqual([{ type: "move", dir: "end" }]);
    });

    it("emits delete for Delete key (\\x1b[3~)", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const actions = parser.parse(Buffer.from("\x1b[3~"));
      expect(actions).toEqual([{ type: "delete" }]);
    });

    it("emits wordLeft for ESC+b (macOS Option+Left)", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const actions = parser.parse(Buffer.from("\x1bb"));
      expect(actions).toEqual([{ type: "move", dir: "wordLeft" }]);
    });

    it("emits wordRight for ESC+f (macOS Option+Right)", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const actions = parser.parse(Buffer.from("\x1bf"));
      expect(actions).toEqual([{ type: "move", dir: "wordRight" }]);
    });

    it("emits deleteWord for ESC+DEL (macOS Option+Backspace)", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const actions = parser.parse(Buffer.from("\x1b\x7f"));
      expect(actions).toEqual([{ type: "deleteWord" }]);
    });

    it("emits insert newline for ESC+Enter (macOS Option+Enter)", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const actions = parser.parse(Buffer.from("\x1b\x0d"));
      expect(actions).toEqual([{ type: "insert", text: "\n" }]);
    });
  });

  describe("fragmented sequences", () => {
    it("handles CSI sequence split across two chunks", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const a1 = parser.parse(Buffer.from("\x1b[1;3"));
      expect(a1).toEqual([]); // incomplete, buffered
      const a2 = parser.parse(Buffer.from("D"));
      expect(a2).toEqual([{ type: "move", dir: "wordLeft" }]);
    });

    it("handles ESC split from bracket", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const a1 = parser.parse(Buffer.from("\x1b"));
      expect(a1).toEqual([]); // lone ESC, wait for timeout or more bytes
      const a2 = parser.parse(Buffer.from("[D"));
      expect(a2).toEqual([{ type: "move", dir: "left" }]);
    });

    it("lone ESC with no followup does not hang state (timeout clears pendingBytes)", async () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const a1 = parser.parse(Buffer.from("\x1b"));
      expect(a1).toEqual([]);
      // Wait for 50ms ESC timeout
      await new Promise(r => setTimeout(r, 60));
      // Next input should work normally — pendingBytes cleared by timeout
      const a2 = parser.parse(Buffer.from("a"));
      expect(a2).toEqual([{ type: "insert", text: "a" }]);
    });
  });

  describe("UTF-8 multibyte split across chunks", () => {
    it("handles emoji split across two data events", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      // 😀 is U+1F600, UTF-8 bytes: F0 9F 98 80
      const emoji = Buffer.from([0xF0, 0x9F, 0x98, 0x80]);
      // Split after 2 bytes
      const a1 = parser.parse(emoji.subarray(0, 2));
      expect(a1).toEqual([]); // incomplete UTF-8, decoder holds bytes
      const a2 = parser.parse(emoji.subarray(2));
      expect(a2).toEqual([{ type: "insert", text: "😀" }]);
    });
  });

  describe("paste terminator split across chunks", () => {
    it("handles paste end marker split across two chunks", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const a1 = parser.parse(Buffer.from("\x1b[200~hello"));
      expect(a1).toEqual([]); // in paste mode
      // Paste end marker split: \x1b[201 in one chunk, ~ in next
      const a2 = parser.parse(Buffer.from("\x1b[201"));
      expect(a2).toEqual([]); // still accumulating
      const a3 = parser.parse(Buffer.from("~"));
      expect(a3).toEqual([{ type: "insert", text: "hello" }]);
    });
  });

  describe("Kitty protocol", () => {
    it("emits insert newline for Shift+Enter", () => {
      const parser = new KeyParser({ kittyEnabled: true });
      const actions = parser.parse(Buffer.from("\x1b[13;2u"));
      expect(actions).toEqual([{ type: "insert", text: "\n" }]);
    });

    it("emits submit for plain Enter in Kitty mode", () => {
      const parser = new KeyParser({ kittyEnabled: true });
      const actions = parser.parse(Buffer.from("\x1b[13;1u"));
      expect(actions).toEqual([{ type: "submit" }]);
    });

    it("still handles Enter byte in Kitty mode", () => {
      const parser = new KeyParser({ kittyEnabled: true });
      const actions = parser.parse(Buffer.from([0x0d]));
      expect(actions).toEqual([{ type: "submit" }]);
    });

    it("emits insert newline for Option+Enter (Alt modifier)", () => {
      const parser = new KeyParser({ kittyEnabled: true });
      const actions = parser.parse(Buffer.from("\x1b[13;3u"));
      expect(actions).toEqual([{ type: "insert", text: "\n" }]);
    });

    it("emits deleteWord for Option+Backspace (Alt+DEL via CSI u)", () => {
      const parser = new KeyParser({ kittyEnabled: true });
      const actions = parser.parse(Buffer.from("\x1b[127;3u"));
      expect(actions).toEqual([{ type: "deleteWord" }]);
    });

    it("emits deleteWord for Ctrl+W", () => {
      const parser = new KeyParser({ kittyEnabled: true });
      const actions = parser.parse(Buffer.from("\x1b[119;5u"));
      expect(actions).toEqual([{ type: "deleteWord" }]);
    });

    it("emits deleteToStart for Ctrl+U", () => {
      const parser = new KeyParser({ kittyEnabled: true });
      const actions = parser.parse(Buffer.from("\x1b[117;5u"));
      expect(actions).toEqual([{ type: "deleteToStart" }]);
    });

    it("emits deleteToEnd for Ctrl+K", () => {
      const parser = new KeyParser({ kittyEnabled: true });
      const actions = parser.parse(Buffer.from("\x1b[107;5u"));
      expect(actions).toEqual([{ type: "deleteToEnd" }]);
    });

    it("emits home for Ctrl+A", () => {
      const parser = new KeyParser({ kittyEnabled: true });
      const actions = parser.parse(Buffer.from("\x1b[97;5u"));
      expect(actions).toEqual([{ type: "move", dir: "home" }]);
    });

    it("emits end for Ctrl+E", () => {
      const parser = new KeyParser({ kittyEnabled: true });
      const actions = parser.parse(Buffer.from("\x1b[101;5u"));
      expect(actions).toEqual([{ type: "move", dir: "end" }]);
    });
  });

  describe("bracketed paste", () => {
    it("accumulates paste content as single insert", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const paste = "\x1b[200~hello\nworld\x1b[201~";
      const actions = parser.parse(Buffer.from(paste));
      expect(actions).toEqual([{ type: "insert", text: "hello\nworld" }]);
    });

    it("strips ANSI from pasted content", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const paste = "\x1b[200~\x1b[31mred text\x1b[0m\x1b[201~";
      const actions = parser.parse(Buffer.from(paste));
      expect(actions).toEqual([{ type: "insert", text: "red text" }]);
    });

    it("handles paste split across chunks", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const a1 = parser.parse(Buffer.from("\x1b[200~hel"));
      expect(a1).toEqual([]); // still in paste mode
      const a2 = parser.parse(Buffer.from("lo\x1b[201~"));
      expect(a2).toEqual([{ type: "insert", text: "hello" }]);
    });

    it("CR inside paste is converted to LF, not stripped", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const paste = "\x1b[200~line1\rline2\x1b[201~";
      const actions = parser.parse(Buffer.from(paste));
      // \r → \n (line ending normalization)
      expect(actions).toEqual([{ type: "insert", text: "line1\nline2" }]);
    });

    it("CRLF inside paste is normalized to single LF", () => {
      const parser = new KeyParser({ kittyEnabled: false });
      const paste = "\x1b[200~line1\r\nline2\x1b[201~";
      const actions = parser.parse(Buffer.from(paste));
      expect(actions).toEqual([{ type: "insert", text: "line1\nline2" }]);
    });
  });

  describe("destroy", () => {
    it("clears pending ESC timer without leaking", async () => {
      const parser = new KeyParser({ kittyEnabled: false });
      parser.parse(Buffer.from("\x1b")); // starts 50ms ESC timer
      parser.destroy();
      // After timeout would have fired, pendingBytes still has the ESC byte
      // (destroy clears the timer, not the buffer). Next parse prepends it,
      // forming ESC+'[' which starts a CSI, or ESC+other which is skipped.
      // The key invariant: no timer leak — the test completing without
      // hanging proves destroy() cleaned up the async resource.
      await new Promise(r => setTimeout(r, 60));
      // ESC + 'a' = unknown escape, skipped. Then 'b' is printable.
      const a = parser.parse(Buffer.from("ab"));
      expect(a).toEqual([{ type: "insert", text: "b" }]);
    });
  });
});
