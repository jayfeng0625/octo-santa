// src/transports/mcp-stdio/helpers.ts
import type { BrainDoc } from "../../core/brain/types";

export function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

export function formatBrainIndex(docs: BrainDoc[]): string {
  return docs.map((d) => `- [${d.path}](${d.slug}) — ${d.summary}`).join("\n");
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
