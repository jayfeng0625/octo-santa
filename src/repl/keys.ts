import type { Direction } from "./buffer";
import { sanitize } from "./utils";

export type Action =
  | { type: "insert"; text: string }
  | { type: "submit" }
  | { type: "exit" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "deleteWord" }
  | { type: "deleteToEnd" }
  | { type: "deleteToStart" }
  | { type: "move"; dir: Direction };

export interface KeyParserOptions {
  kittyEnabled: boolean;
}

/** Sanitize pasted text: normalize line endings, then apply shared sanitize. */
function sanitizePaste(text: string): string {
  return sanitize(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
}

export class KeyParser {
  readonly kittyEnabled: boolean;
  private pendingBytes: number[] = [];
  private inPaste = false;
  private pasteBuffer: number[] = [];
  private escTimer: ReturnType<typeof setTimeout> | null = null;
  private utf8Decoder = new TextDecoder("utf-8");

  constructor(opts: KeyParserOptions) {
    this.kittyEnabled = opts.kittyEnabled;
  }

  parse(data: Buffer): Action[] {
    // Cancel any pending Esc timeout since new data arrived
    if (this.escTimer !== null) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }

    const bytes = [...this.pendingBytes, ...data];
    this.pendingBytes = [];
    const actions: Action[] = [];
    let insertBuf = "";

    const flushInsert = () => {
      if (insertBuf.length > 0) {
        actions.push({ type: "insert", text: insertBuf });
        insertBuf = "";
      }
    };

    let i = 0;
    while (i < bytes.length) {
      const b = bytes[i]!;

      // Check for bracketed paste markers (6 bytes each: \x1b[200~ and \x1b[201~)
      if (b === 0x1b) {
        // Could be start or end of paste bracket — need 6 bytes total
        const remaining = bytes.length - i;
        if (remaining >= 6) {
          const seqStr = String.fromCharCode(...bytes.slice(i, i + 6));
          if (seqStr === "\x1b[200~") {
            flushInsert();
            this.inPaste = true;
            this.pasteBuffer = [];
            i += 6;
            continue;
          }
          if (seqStr === "\x1b[201~" && this.inPaste) {
            this.inPaste = false;
            const raw = this.utf8Decoder.decode(new Uint8Array(this.pasteBuffer));
            const clean = sanitizePaste(raw);
            if (clean.length > 0) {
              flushInsert();
              actions.push({ type: "insert", text: clean });
            }
            this.pasteBuffer = [];
            i += 6;
            continue;
          }
        } else if (this.inPaste) {
          // Partial paste terminator at end of chunk — buffer remaining bytes
          for (let j = i; j < bytes.length; j++) this.pasteBuffer.push(bytes[j]!);
          return actions;
        }
      }

      // Inside paste bracket — accumulate everything (including potential partial ESC sequences)
      if (this.inPaste) {
        // Check if pasteBuffer ends with a partial paste terminator
        // and this byte completes it
        if (this.pasteBuffer.length >= 5) {
          // Check if accumulated bytes form the paste end marker
          const combined = [...this.pasteBuffer.slice(-5), b];
          if (combined.length >= 6) {
            const tail = combined.slice(-6);
            const tailStr = String.fromCharCode(...tail);
            if (tailStr === "\x1b[201~") {
              // Remove the partial marker bytes from pasteBuffer
              this.pasteBuffer.splice(-(5), 5);
              this.inPaste = false;
              const raw = this.utf8Decoder.decode(new Uint8Array(this.pasteBuffer));
              const clean = sanitizePaste(raw);
              if (clean.length > 0) {
                flushInsert();
                actions.push({ type: "insert", text: clean });
              }
              this.pasteBuffer = [];
              i++;
              continue;
            }
          }
        }
        this.pasteBuffer.push(b);
        i++;
        continue;
      }

      // ESC — start of escape sequence
      if (b === 0x1b) {
        flushInsert();
        if (i + 1 >= bytes.length) {
          // Lone ESC at end of chunk — buffer and set timeout
          this.pendingBytes = [0x1b];
          this.escTimer = setTimeout(() => {
            this.pendingBytes = [];
            this.escTimer = null;
            // Standalone Esc — currently unused, discard
          }, 50);
          i++;
          continue;
        }
        if (bytes[i + 1] === 0x5b) { // [
          // CSI sequence
          const result = this.parseCSI(bytes, i + 2);
          if (result === null) {
            // Incomplete — buffer remaining bytes
            this.pendingBytes = bytes.slice(i);
            return actions;
          }
          if (result.action) actions.push(result.action);
          i = result.nextIndex;
          continue;
        }
        // ESC + other char — skip (unknown sequence)
        i += 2;
        continue;
      }

      // Control characters
      if (b === 0x0d || b === 0x0a) { // Enter
        flushInsert();
        actions.push({ type: "submit" });
        i++;
        continue;
      }
      if (b === 0x03) { // Ctrl+C
        flushInsert();
        actions.push({ type: "exit" });
        i++;
        continue;
      }
      if (b === 0x7f || b === 0x08) { // Backspace
        flushInsert();
        actions.push({ type: "backspace" });
        i++;
        continue;
      }
      if (b === 0x17) { // Ctrl+W
        flushInsert();
        actions.push({ type: "deleteWord" });
        i++;
        continue;
      }
      if (b === 0x15) { // Ctrl+U
        flushInsert();
        actions.push({ type: "deleteToStart" });
        i++;
        continue;
      }
      if (b === 0x0b) { // Ctrl+K
        flushInsert();
        actions.push({ type: "deleteToEnd" });
        i++;
        continue;
      }
      if (b === 0x01) { // Ctrl+A
        flushInsert();
        actions.push({ type: "move", dir: "home" });
        i++;
        continue;
      }
      if (b === 0x05) { // Ctrl+E
        flushInsert();
        actions.push({ type: "move", dir: "end" });
        i++;
        continue;
      }

      // Skip other control chars
      if (b < 0x20) {
        i++;
        continue;
      }

      // Printable byte — accumulate contiguous printable bytes for batch UTF-8 decode
      const start = i;
      while (i < bytes.length && bytes[i]! >= 0x20 && bytes[i]! !== 0x7f && bytes[i]! !== 0x1b) {
        i++;
      }
      const chunk = new Uint8Array(bytes.slice(start, i));
      // Use { stream: true } to preserve incomplete multibyte sequences across parse() calls.
      // The decoder remembers trailing bytes internally; they'll be completed by the next chunk.
      insertBuf += this.utf8Decoder.decode(chunk, { stream: true });
    }

    // Do NOT call this.utf8Decoder.decode() (no args) here — that flushes the stream
    // and resets state, corrupting multibyte characters split across data events.
    // The decoder carries incomplete bytes internally until the next parse() call.
    flushInsert();
    return actions;
  }

  private parseCSI(
    bytes: number[],
    start: number
  ): { action: Action | null; nextIndex: number } | null {
    let i = start;
    let params = "";

    // Collect parameter bytes (0x30-0x3f: digits, semicolons, etc.)
    while (i < bytes.length && bytes[i]! >= 0x30 && bytes[i]! <= 0x3f) {
      params += String.fromCharCode(bytes[i]!);
      i++;
    }

    // Collect intermediate bytes (0x20-0x2f)
    while (i < bytes.length && bytes[i]! >= 0x20 && bytes[i]! <= 0x2f) {
      i++;
    }

    // Final byte (0x40-0x7e)
    if (i >= bytes.length) return null; // Incomplete sequence

    const final = bytes[i]!;
    i++;

    const action = this.dispatchCSI(params, final);
    return { action, nextIndex: i };
  }

  private dispatchCSI(params: string, final: number): Action | null {
    const finalChar = String.fromCharCode(final);

    // Kitty protocol: CSI codepoint ; modifier u
    if (finalChar === "u" && this.kittyEnabled) {
      const parts = params.split(";");
      const codepoint = parseInt(parts[0] ?? "", 10);
      const modifier = parseInt(parts[1] ?? "1", 10);
      if (codepoint === 13 || codepoint === 10) {
        // Enter with modifier
        if ((modifier - 1) & 1) {
          // Shift bit set — Shift+Enter → insert newline
          return { type: "insert", text: "\n" };
        }
        return { type: "submit" };
      }
      return null;
    }

    // Arrow keys and modifiers
    switch (finalChar) {
      case "A": return { type: "move", dir: "up" };
      case "B": return { type: "move", dir: "down" };
      case "C": {
        // Check for modifier (Alt = 3)
        if (params === "1;3") return { type: "move", dir: "wordRight" };
        return { type: "move", dir: "right" };
      }
      case "D": {
        if (params === "1;3") return { type: "move", dir: "wordLeft" };
        return { type: "move", dir: "left" };
      }
      case "H": return { type: "move", dir: "home" };
      case "F": return { type: "move", dir: "end" };
      case "~": {
        if (params === "3") return { type: "delete" };
        return null;
      }
    }
    return null;
  }

  destroy(): void {
    if (this.escTimer !== null) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
  }
}
