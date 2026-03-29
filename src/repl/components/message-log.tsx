import React from "react";
import { Text, Box } from "ink";

export interface LogEntry {
  text: string;
  system?: boolean;
}

export function MessageLog({ messages }: { messages: LogEntry[] }) {
  if (messages.length === 0) return null;

  return (
    <Box flexDirection="column">
      {messages.map((msg, i) => (
        <Text key={i} dimColor={msg.system}>
          {msg.text}
        </Text>
      ))}
    </Box>
  );
}
