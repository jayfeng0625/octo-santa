// src/transports/mcp-stdio/helpers.ts
export function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

export function withAgent<T>(
  onAgentId: ((agentId: string) => { commit: (resolvedName?: string) => void }) | undefined,
  agentId: string,
  fn: () => T
): T {
  const handle = onAgentId?.(agentId);
  const result = fn();
  handle?.commit();
  return result;
}
