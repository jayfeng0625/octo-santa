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

      // Shift+Enter (Kitty protocol: \x1b[13;2u) -> insert newline
      if (key.return && key.shift) {
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

  const lines = value.split("\n");

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i}>
          {i === 0 ? `${prompt}> ` : "  "}
          {line}
        </Text>
      ))}
    </Box>
  );
}
