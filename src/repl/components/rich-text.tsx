// src/repl/components/rich-text.tsx

import React from "react";
import { Text, type TextProps } from "ink";

export type TokenStyle = "mention" | "channel" | "code" | "bold" | "italic" | "agent" | "channelPrefix";

export interface Token {
  text: string;
  style?: TokenStyle;
}

// Patterns matched in order. First match at a position wins.
// Agent/channel prefixes only match at position 0 (start of text).
const INLINE_PATTERN = new RegExp(
  [
    "(@[\\w-]+)",           // @mention
    "(#[\\w-]+)",           // #channel
    "(`[^`]+`)",            // `code`
    "(\\*\\*[^*]+\\*\\*)",  // **bold**
    "(\\*[^*]+\\*)",        // *italic*
  ].join("|"),
  "g",
);

const PREFIX_PATTERN = /^(?:(\[#[\w-]+\])(\[[\w-]+\])|\[#[\w-]+\]|\[[\w-]+\])/;

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let rest = input;

  // Phase 1: extract leading prefixes ([#channel][agent] or [agent])
  const prefixMatch = rest.match(PREFIX_PATTERN);
  if (prefixMatch) {
    const fullMatch = prefixMatch[0];
    // Check if it's [#channel][agent] combo
    const channelPrefixMatch = fullMatch.match(/^(\[#[\w-]+\])(\[[\w-]+\])/);
    if (channelPrefixMatch) {
      tokens.push({ text: channelPrefixMatch[1]!, style: "channelPrefix" });
      tokens.push({ text: channelPrefixMatch[2]!, style: "agent" });
    } else if (fullMatch.startsWith("[#")) {
      tokens.push({ text: fullMatch, style: "channelPrefix" });
    } else {
      tokens.push({ text: fullMatch, style: "agent" });
    }
    rest = rest.slice(fullMatch.length);
  }

  // Phase 2: tokenize remaining text with inline patterns
  if (!rest) return tokens;

  let lastIndex = 0;
  INLINE_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = INLINE_PATTERN.exec(rest)) !== null) {
    // Push plain text before this match
    if (match.index > lastIndex) {
      tokens.push({ text: rest.slice(lastIndex, match.index) });
    }

    const matched = match[0];
    let style: TokenStyle;
    if (match[1]) style = "mention";
    else if (match[2]) style = "channel";
    else if (match[3]) style = "code";
    else if (match[4]) style = "bold";
    else style = "italic";

    tokens.push({ text: matched, style });
    lastIndex = match.index + matched.length;
  }

  // Push remaining plain text
  if (lastIndex < rest.length) {
    tokens.push({ text: rest.slice(lastIndex) });
  }

  return tokens;
}

const STYLE_PROPS: Record<TokenStyle, TextProps> = {
  mention: { color: "blue" },
  channel: { color: "green" },
  code: { color: "yellow" },
  bold: { bold: true },
  italic: { italic: true },
  agent: { color: "cyan" },
  channelPrefix: { color: "cyan", dimColor: true },
};

export function RichText({ text }: { text: string }) {
  const tokens = tokenize(text);

  return (
    <Text>
      {tokens.map((token, i) =>
        token.style ? (
          <Text key={i} {...STYLE_PROPS[token.style]}>
            {token.text}
          </Text>
        ) : (
          <Text key={i}>{token.text}</Text>
        )
      )}
    </Text>
  );
}
