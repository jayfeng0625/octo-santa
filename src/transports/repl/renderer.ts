import type { InputBuffer } from "./buffer";

import { sanitize } from "./utils";
export { sanitize }; // re-export for tests that import from renderer

// ANSI color codes for agent name coloring (256-color palette subset, readable on dark/light)
const AGENT_COLORS = [31, 32, 33, 34, 35, 36, 91, 92, 93, 94, 95, 96];

/** Hash-based color assignment for agent names */
export function agentColor(agentId: string): number {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = ((hash << 5) - hash + agentId.charCodeAt(i)) | 0;
  }
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length]!;
}

export interface FormattedMessage {
  plain: string;   // without ANSI colors (for testing)
  colored: string; // with ANSI colors (for display)
}

/** Format a message for display with multiline indentation */
export function formatMessage(
  msg: { agent_id: string; content: string },
  channelName: string,
  activeChannel: string
): FormattedMessage {
  const cleanAgent = sanitize(msg.agent_id);
  const cleanContent = sanitize(msg.content);
  const channelPrefix = channelName === activeChannel ? "" : `[#${sanitize(channelName)}]`;

  const header = `${channelPrefix}[${cleanAgent}] `;
  const indent = " ".repeat(header.length);

  const contentLines = cleanContent.split("\n");
  const plainLines = contentLines.map((line, i) =>
    i === 0 ? `${header}${line}` : `${indent}${line}`
  );

  const color = agentColor(cleanAgent);
  const coloredHeader = channelPrefix
    ? `\x1b[2m${channelPrefix}\x1b[0m\x1b[${color}m[${cleanAgent}]\x1b[0m `
    : `\x1b[${color}m[${cleanAgent}]\x1b[0m `;

  const coloredLines = contentLines.map((line, i) =>
    i === 0 ? `${coloredHeader}${line}` : `${indent}${line}`
  );

  return {
    plain: plainLines.join("\n"),
    colored: coloredLines.join("\n"),
  };
}

export class Renderer {
  private termWidth: number;
  private inputLineCount = 1; // how many terminal lines the input area occupies
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private onResize: (() => void) | null = null;
  private readonly sigwinchHandler: () => void;

  constructor() {
    this.termWidth = process.stdout.columns || 80;
    this.sigwinchHandler = () => this.handleResize();
    process.on("SIGWINCH", this.sigwinchHandler);
  }

  setResizeHandler(handler: () => void): void {
    this.onResize = handler;
  }

  private handleResize(): void {
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.termWidth = process.stdout.columns || 80;
      this.resizeTimer = null;
      this.onResize?.();
    }, 100);
  }

  /** Expand tabs to spaces (4-space tab stops) */
  private expandTabs(text: string): string {
    let result = "";
    let col = 0;
    for (const ch of text) {
      if (ch === "\t") {
        const spaces = 4 - (col % 4);
        result += " ".repeat(spaces);
        col += spaces;
      } else {
        result += ch;
        col++;
      }
    }
    return result;
  }

  /** Compute display width of a string (after tab expansion).
   *  Single source of truth for width — used by both rendering and cursor math. */
  private displayWidth(text: string): number {
    return this.expandTabs(text).length;
  }

  /** Compute how many visual terminal lines a logical line occupies.
   *  Note: when displayLen is an exact multiple of termWidth, the terminal
   *  cursor sits at col 0 of the next line. Math.ceil handles this correctly
   *  for display (80/80=1), but cursor positioning may be off by one row in
   *  that edge case. Verify during manual testing (Task 8). */
  private visualLineCount(displayLen: number): number {
    if (displayLen === 0) return 1;
    return Math.ceil(displayLen / this.termWidth) || 1;
  }

  /** Compute visual cursor position accounting for tab expansion and line wrapping */
  private computeCursorVisual(
    prompt: string,
    buffer: InputBuffer
  ): { totalVisualLines: number; cursorVisualRow: number; cursorVisualCol: number } {
    const promptLen = prompt.length;
    let totalVisualLines = 0;
    let cursorVisualRow = 0;
    let cursorVisualCol = 0;

    for (let r = 0; r < buffer.lines.length; r++) {
      const lineDisplayLen = promptLen + this.displayWidth(buffer.lines[r]!);
      const visualLines = this.visualLineCount(lineDisplayLen);

      if (r === buffer.cursorRow) {
        const textBeforeCursor = buffer.lines[r]!.slice(0, buffer.cursorCol);
        const cursorDisplayOffset = promptLen + this.displayWidth(textBeforeCursor);
        const wrapRow = Math.floor(cursorDisplayOffset / this.termWidth);
        const wrapCol = cursorDisplayOffset % this.termWidth;
        cursorVisualRow = totalVisualLines + wrapRow;
        cursorVisualCol = wrapCol;
      }

      totalVisualLines += visualLines;
    }

    return { totalVisualLines, cursorVisualRow, cursorVisualCol };
  }

  /** Render the prompt + input buffer, positioning cursor correctly */
  renderInput(prompt: string, buffer: InputBuffer): void {
    if (this.inputLineCount > 1) {
      process.stdout.write(`\x1b[${this.inputLineCount - 1}A`);
    }
    process.stdout.write(`\r\x1b[J`);

    const indent = " ".repeat(prompt.length);
    const fullText = buffer.lines
      .map((line, i) => (i === 0 ? prompt + line : indent + line))
      .join("\n");
    process.stdout.write(fullText);

    const { totalVisualLines, cursorVisualRow, cursorVisualCol } =
      this.computeCursorVisual(prompt, buffer);
    this.inputLineCount = totalVisualLines;

    const linesFromBottom = totalVisualLines - 1 - cursorVisualRow;
    if (linesFromBottom > 0) {
      process.stdout.write(`\x1b[${linesFromBottom}A`);
    }
    process.stdout.write(`\r\x1b[${cursorVisualCol + 1}G`);
  }

  /** Print a message above the input area, then redraw input */
  printMessage(msg: FormattedMessage, prompt: string, buffer: InputBuffer): void {
    if (this.inputLineCount > 1) {
      process.stdout.write(`\x1b[${this.inputLineCount - 1}A`);
    }
    process.stdout.write(`\r\x1b[J`);
    process.stdout.write(msg.colored + "\n\n");
    this.inputLineCount = 1;
    this.renderInput(prompt, buffer);
  }

  /** Print untrusted command output above input area, then redraw input. */
  printOutput(text: string, prompt: string, buffer: InputBuffer): void {
    this.printRaw(sanitize(text) + "\n", prompt, buffer);
  }

  /** Print pre-formatted trusted output */
  private printRaw(text: string, prompt: string, buffer: InputBuffer): void {
    if (this.inputLineCount > 1) {
      process.stdout.write(`\x1b[${this.inputLineCount - 1}A`);
    }
    process.stdout.write(`\r\x1b[J`);
    process.stdout.write(text);
    this.inputLineCount = 1;
    this.renderInput(prompt, buffer);
  }

  /** Print an error message in red */
  printError(message: string, prompt: string, buffer: InputBuffer): void {
    const safeMessage = sanitize(message);
    this.printRaw(`\n\x1b[31m[error]\x1b[0m ${safeMessage}\n`, prompt, buffer);
  }

  destroy(): void {
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
    process.off("SIGWINCH", this.sigwinchHandler);
  }
}
