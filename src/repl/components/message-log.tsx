import React from "react";
import { Text, Box } from "ink";
import { RichText } from "./rich-text";

export interface LogEntry {
  text: string;
  system?: boolean;
}

export function MessageLog({ messages }: { messages: LogEntry[] }) {
  if (messages.length === 0) return null;

  return (
    <Box flexDirection="column">
      {messages.map((msg, i) =>
        msg.system ? (
          <Text key={i} dimColor>
            {msg.text}
          </Text>
        ) : (
          <RichText key={i} text={msg.text} />
        )
      )}
    </Box>
  );
}
