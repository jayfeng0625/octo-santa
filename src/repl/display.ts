// src/repl/display.ts

/** Strip ANSI escape sequences and control characters (except \n and \t) */
export function sanitize(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\r]/g, "");
}

export function formatMessage(
  msg: { agent_id: string; content: string },
  channelName: string,
  activeChannel: string
): string {
  const prefix = channelName === activeChannel ? "" : `[#${sanitize(channelName)}]`;
  return `${prefix}[${sanitize(msg.agent_id)}] ${sanitize(msg.content)}`;
}
