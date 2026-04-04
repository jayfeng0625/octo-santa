import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { OctoModule } from "../../types";
import {
  brainMigrations,
  readConfig,
  upsertDomain,
  scanBrainDocs,
  readBrainDoc,
  scanSharedBrainDocs,
  readSharedBrainDoc,
  findExperts,
  claimDomain,
  onBrainDisconnect,
} from "./tools";

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function withAgent<T>(
  onAgentId: ((agentId: string) => { commit: () => void }) | undefined,
  agentId: string,
  fn: () => T
): T {
  const handle = onAgentId?.(agentId);
  const result = fn();
  handle?.commit();
  return result;
}

const brain: OctoModule = {
  name: "brain",
  migrations: brainMigrations,

  registerTools(server: McpServer, getDb: () => Database, onAgentId?: (agentId: string) => { commit: () => void }) {
    const cwd = process.cwd();
    const config = readConfig(cwd);
    if (config?.domain) {
      upsertDomain(getDb(), config, cwd);
    }

    server.registerTool("brain_index", {
      description: "List brain documents for this repo (from .octo-santa/config.json brain.dirs)",
    }, async () => {
      if (!config?.brain?.dirs) return { content: [{ type: "text" as const, text: "" }] };
      const docs = scanBrainDocs(cwd, config.brain.dirs);
      if (docs.length === 0) return { content: [{ type: "text" as const, text: "" }] };
      const index = docs.map(d => `- [${d.path}](${d.slug}) — ${d.summary}`).join("\n");
      return { content: [{ type: "text" as const, text: index }] };
    });

    server.registerTool("brain_read", {
      description: "Read a brain document by slug",
      inputSchema: { slug: z.string().trim().min(1).describe("Document slug (filename without .md)") },
    }, async ({ slug }) => {
      if (!config?.brain?.dirs) throw new Error("No brain dirs configured");
      const content = readBrainDoc(cwd, config.brain.dirs, slug);
      return { content: [{ type: "text" as const, text: content }] };
    });

    server.registerTool("brain_shared_index", {
      description: "List shared brain documents from ~/.octo-santa/brain/",
    }, async () => {
      const docs = scanSharedBrainDocs();
      if (docs.length === 0) return { content: [{ type: "text" as const, text: "" }] };
      const index = docs.map(d => `- [${d.path}](${d.slug}) — ${d.summary}`).join("\n");
      return { content: [{ type: "text" as const, text: index }] };
    });

    server.registerTool("brain_shared_read", {
      description: "Read a shared brain document by slug",
      inputSchema: { slug: z.string().trim().min(1).describe("Document slug (filename without .md)") },
    }, async ({ slug }) => {
      const content = readSharedBrainDoc(slug);
      return { content: [{ type: "text" as const, text: content }] };
    });

    server.registerTool("brain_find_expert", {
      description: "Find domain experts across all connected repos. Returns domains with active agent sessions.",
    }, async () => {
      return jsonResult(findExperts(getDb()));
    });

    server.registerTool("brain_claim_domain", {
      description: "Claim this repo's domain identity for your agent session. Requires prior messaging_register.",
      inputSchema: { agent_id: z.string().trim().min(1).describe("Your registered agent name") },
    }, async ({ agent_id }) => {
      return withAgent(onAgentId, agent_id, () => {
        claimDomain(getDb(), agent_id, cwd, config);
        return jsonResult({ claimed: config?.domain?.identifier ?? null, agent_id });
      });
    });
  },

  onDisconnect(db: Database, agentId: string, pid: number) {
    onBrainDisconnect(db, agentId, pid);
  },
};

export default brain;
