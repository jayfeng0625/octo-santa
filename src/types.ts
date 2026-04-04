// src/types.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Migration } from "./migrations";

export interface OctoModule {
  name: string;
  migrations: Migration[];
  registerTools: (
    server: McpServer,
    getDb: () => import("bun:sqlite").Database,
    onAgentId?: (agentId: string) => { commit: () => void }
  ) => void;
  onDisconnect?: (db: import("bun:sqlite").Database, agentId: string, pid: number) => void;
}
