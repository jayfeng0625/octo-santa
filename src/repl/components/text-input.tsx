import React, { useState } from "react";
import { Text, Box, useInput } from "ink";

export interface TextInputProps {
  prompt: string;
  onSubmit: (value: string) => void;
  onExit?: () => void;
}

export function TextInput({ prompt, onSubmit, onExit }: TextInputProps) {
  const [value, setValue] = useState("");
  const [cursorPos, setCursorPos] = useState(0);

  useInput(
    (input, key) => {
      // Ctrl+C -> exit
      if (key.ctrl && input === "c") {
        onExit?.();
        return;
      }

      // Newline insertion:
      //   Shift+Enter (Kitty protocol) — key.return && key.shift
      //   Alt/Option+Enter (universal) — key.return && key.meta
      if (key.return && (key.shift || key.meta)) {
        setValue((v) => v.slice(0, cursorPos) + "\n" + v.slice(cursorPos));
        setCursorPos((p) => p + 1);
        return;
      }

      // Enter -> submit
      if (key.return) {
        if (!value.trim()) return;
        onSubmit(value);
        setValue("");
        setCursorPos(0);
        return;
      }

      // Backspace / Delete
      if (key.backspace || key.delete) {
        if (cursorPos > 0) {
          setValue((v) => v.slice(0, cursorPos - 1) + v.slice(cursorPos));
          setCursorPos((p) => p - 1);
        }
        return;
      }

      // Left arrow
      if (key.leftArrow) {
        setCursorPos((p) => Math.max(0, p - 1));
        return;
      }

      // Right arrow
      if (key.rightArrow) {
        setCursorPos((p) => Math.min(value.length, p + 1));
        return;
      }

      // Up arrow -> move cursor to same column on previous line
      if (key.upArrow) {
        const before = value.slice(0, cursorPos);
        const lastNl = before.lastIndexOf("\n");
        if (lastNl === -1) return; // already on first line
        const colInCurrentLine = cursorPos - lastNl - 1;
        const prevLineStart = before.lastIndexOf("\n", lastNl - 1) + 1;
        const prevLineLen = lastNl - prevLineStart;
        setCursorPos(prevLineStart + Math.min(colInCurrentLine, prevLineLen));
        return;
      }

      // Down arrow -> move cursor to same column on next line
      if (key.downArrow) {
        const after = value.slice(cursorPos);
        const nextNl = after.indexOf("\n");
        if (nextNl === -1) return; // already on last line
        const before = value.slice(0, cursorPos);
        const currentLineStart = before.lastIndexOf("\n") + 1;
        const colInCurrentLine = cursorPos - currentLineStart;
        const nextLineStart = cursorPos + nextNl + 1;
        const nextLineEnd = value.indexOf("\n", nextLineStart);
        const nextLineLen =
          (nextLineEnd === -1 ? value.length : nextLineEnd) - nextLineStart;
        setCursorPos(nextLineStart + Math.min(colInCurrentLine, nextLineLen));
        return;
      }

      // Regular character input — ignore escape sequences and control chars
      if (input && !key.ctrl && !key.meta) {
        setValue((v) => v.slice(0, cursorPos) + input + v.slice(cursorPos));
        setCursorPos((p) => p + input.length);
      }
    },
    { isActive: true },
  );

  // Render lines with a visible cursor (inverse video on cursor character)
  const lines = value.split("\n");
  const promptPrefix = `${prompt}> `;
  const contPrefix = "  ";

  // Compute which line and column the cursor is on
  let charsSoFar = 0;
  let cursorLine = 0;
  let cursorCol = 0;
  for (let i = 0; i < lines.length; i++) {
    if (cursorPos <= charsSoFar + lines[i]!.length) {
      cursorLine = i;
      cursorCol = cursorPos - charsSoFar;
      break;
    }
    charsSoFar += lines[i]!.length + 1; // +1 for \n
  }

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const prefix = i === 0 ? promptPrefix : contPrefix;
        if (i === cursorLine) {
          const before = line.slice(0, cursorCol);
          const cursorChar = line[cursorCol] ?? " ";
          const after = line.slice(cursorCol + 1);
          return (
            <Text key={i}>
              {prefix}{before}<Text inverse>{cursorChar}</Text>{after}
            </Text>
          );
        }
        return (
          <Text key={i}>
            {prefix}{line}
          </Text>
        );
      })}
    </Box>
  );
}
