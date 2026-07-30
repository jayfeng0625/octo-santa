// Tool results carry the same object twice: human/legacy-readable JSON text
// and validated structuredContent. Keep results top-level objects — object
// shapes project identically onto both protocol eras.
export function jsonResult<T extends object>(data: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

export function withAgent<T>(
  onAgentId: ((agentId: string) => { commit: () => void }) | undefined,
  agentId: string,
  fn: () => T
): T {
  const handle = onAgentId?.(agentId);
  const result = fn();
  handle?.commit();
  return result;
}
