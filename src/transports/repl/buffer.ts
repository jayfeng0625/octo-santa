const WORD_CHAR_RE = /[\w\p{L}\p{N}]/u;

export type Direction =
  | "left" | "right" | "up" | "down"
  | "wordLeft" | "wordRight"
  | "home" | "end";

export class InputBuffer {
  lines: string[] = [""];
  cursorRow = 0;
  cursorCol = 0;
  preferredCol: number | null = null;

  insert(text: string): void {
    const parts = text.split("\n");
    const line = this.lines[this.cursorRow]!;
    const before = line.slice(0, this.cursorCol);
    const after = line.slice(this.cursorCol);

    if (parts.length === 1) {
      this.lines[this.cursorRow] = before + parts[0] + after;
      this.cursorCol += parts[0]!.length;
    } else {
      this.lines[this.cursorRow] = before + parts[0];
      for (let i = 1; i < parts.length - 1; i++) {
        this.lines.splice(this.cursorRow + i, 0, parts[i]!);
      }
      const lastPart = parts[parts.length - 1]!;
      this.lines.splice(this.cursorRow + parts.length - 1, 0, lastPart + after);
      this.cursorRow += parts.length - 1;
      this.cursorCol = lastPart.length;
    }
    this.preferredCol = null;
  }

  move(dir: Direction): void {
    switch (dir) {
      case "left":
        if (this.cursorCol > 0) {
          this.cursorCol--;
        } else if (this.cursorRow > 0) {
          this.cursorRow--;
          this.cursorCol = this.lines[this.cursorRow]!.length;
        }
        this.preferredCol = null;
        break;
      case "right":
        if (this.cursorCol < this.lines[this.cursorRow]!.length) {
          this.cursorCol++;
        } else if (this.cursorRow < this.lines.length - 1) {
          this.cursorRow++;
          this.cursorCol = 0;
        }
        this.preferredCol = null;
        break;
      case "up":
        if (this.cursorRow > 0) {
          this.preferredCol ??= this.cursorCol;
          this.cursorRow--;
          this.cursorCol = Math.min(this.preferredCol, this.lines[this.cursorRow]!.length);
        }
        break;
      case "down":
        if (this.cursorRow < this.lines.length - 1) {
          this.preferredCol ??= this.cursorCol;
          this.cursorRow++;
          this.cursorCol = Math.min(this.preferredCol, this.lines[this.cursorRow]!.length);
        }
        break;
      case "home":
        this.cursorCol = 0;
        this.preferredCol = null;
        break;
      case "end":
        this.cursorCol = this.lines[this.cursorRow]!.length;
        this.preferredCol = null;
        break;
      case "wordLeft": {
        const line = this.lines[this.cursorRow]!;
        let i = this.cursorCol - 1;
        if (i < 0) {
          if (this.cursorRow > 0) {
            this.cursorRow--;
            this.cursorCol = this.lines[this.cursorRow]!.length;
          }
          break;
        }
        // Skip non-word chars, then word chars
        while (i >= 0 && !WORD_CHAR_RE.test(line[i]!)) i--;
        while (i >= 0 && WORD_CHAR_RE.test(line[i]!)) i--;
        this.cursorCol = i + 1;
        this.preferredCol = null;
        break;
      }
      case "wordRight": {
        const line = this.lines[this.cursorRow]!;
        let i = this.cursorCol;
        if (i >= line.length) {
          if (this.cursorRow < this.lines.length - 1) {
            this.cursorRow++;
            this.cursorCol = 0;
          }
          break;
        }
        // Skip word chars, then non-word chars
        while (i < line.length && WORD_CHAR_RE.test(line[i]!)) i++;
        while (i < line.length && !WORD_CHAR_RE.test(line[i]!)) i++;
        this.cursorCol = i;
        this.preferredCol = null;
        break;
      }
    }
  }

  backspace(): void {
    if (this.cursorCol > 0) {
      const line = this.lines[this.cursorRow]!;
      this.lines[this.cursorRow] = line.slice(0, this.cursorCol - 1) + line.slice(this.cursorCol);
      this.cursorCol--;
    } else if (this.cursorRow > 0) {
      const currentLine = this.lines[this.cursorRow]!;
      const prevLine = this.lines[this.cursorRow - 1]!;
      this.lines[this.cursorRow - 1] = prevLine + currentLine;
      this.lines.splice(this.cursorRow, 1);
      this.cursorRow--;
      this.cursorCol = prevLine.length;
    }
    this.preferredCol = null;
  }

  delete(): void {
    const line = this.lines[this.cursorRow]!;
    if (this.cursorCol < line.length) {
      this.lines[this.cursorRow] = line.slice(0, this.cursorCol) + line.slice(this.cursorCol + 1);
    } else if (this.cursorRow < this.lines.length - 1) {
      this.lines[this.cursorRow] = line + this.lines[this.cursorRow + 1]!;
      this.lines.splice(this.cursorRow + 1, 1);
    }
    this.preferredCol = null;
  }

  deleteWord(): void {
    if (this.cursorCol === 0) {
      if (this.cursorRow > 0) this.backspace();
      return;
    }
    const line = this.lines[this.cursorRow]!;
    let i = this.cursorCol - 1;
    while (i >= 0 && !WORD_CHAR_RE.test(line[i]!)) i--;
    while (i >= 0 && WORD_CHAR_RE.test(line[i]!)) i--;
    const newCol = i + 1;
    this.lines[this.cursorRow] = line.slice(0, newCol) + line.slice(this.cursorCol);
    this.cursorCol = newCol;
    this.preferredCol = null;
  }

  deleteToEnd(): void {
    this.lines[this.cursorRow] = this.lines[this.cursorRow]!.slice(0, this.cursorCol);
    this.preferredCol = null;
  }

  deleteToStart(): void {
    this.lines[this.cursorRow] = this.lines[this.cursorRow]!.slice(this.cursorCol);
    this.cursorCol = 0;
    this.preferredCol = null;
  }

  submit(): string {
    const text = this.lines.join("\n");
    this.lines = [""];
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.preferredCol = null;
    return text;
  }

  clear(): void {
    this.lines = [""];
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.preferredCol = null;
  }

  getText(): string {
    return this.lines.join("\n");
  }

  isMultiline(): boolean {
    return this.lines.length > 1;
  }
}
