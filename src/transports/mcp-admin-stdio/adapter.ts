import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import type { AdminService } from "../../core/admin/service";
import { log } from "../../log";
import { AdminParamsInput, SearchOutput, ExecuteOutput } from "./schemas";
import pkg from "../../../package.json";

// The admin plane touches only the local shared SQLite database.
const LOCAL = { openWorldHint: false } as const;

export const ADMIN_TYPEHEAD_URI = "octo-santa://admin/typehead.d.ts";

// Tool results carry the object twice (JSON text + structuredContent) so both
// protocol eras project identically — same convention as the messaging plane.
function jsonResult<T extends object>(data: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

// Claude Code truncates server instructions at 2KB — keep this text under
// that limit.
export function buildAdminInstructions(admin: AdminService): string {
  const { provider, dialect } = admin.describe();
  return (
    "octo-santa ADMIN plane: elevated, direct access to the shared storage " +
    `layer (provider: ${provider}). This connection is for approved apps that ` +
    "integrate with octo-santa programmatically — issue-tracker bridges " +
    "pushing events into channels, analytics over message history — without " +
    "going through the chat-style messaging tools.\n\n" +
    "Exactly two tools, code-mode style:\n" +
    `- admin_search: read-only query (${dialect} dialect). Mutations are rejected.\n` +
    `- admin_execute: one mutating ${dialect} statement, applied atomically.\n\n` +
    `START by reading resource ${ADMIN_TYPEHEAD_URI} — a TypeScript .d.ts ` +
    "typehead authored by the storage provider. It defines every table's row " +
    "shape, the search/execute contracts, and the delivery invariants " +
    "(inserting into `messages` with a `mentions` JSON array IS how you push " +
    "to agents — their processes watch the database).\n\n" +
    "This plane bypasses messaging-level checks (membership, registration, " +
    "cursors). You are expected to uphold the invariants the typehead documents."
  );
}

export function registerAdminTools(server: McpServer, admin: AdminService): void {
  server.registerTool("admin_search", {
    title: "Search storage (read-only)",
    description:
      "Run a read-only query against octo-santa's storage layer in the provider's dialect. " +
      `Mutations are rejected. Read the ${ADMIN_TYPEHEAD_URI} resource for the schema typehead.`,
    annotations: { ...LOCAL, readOnlyHint: true, idempotentHint: true },
    outputSchema: SearchOutput,
    inputSchema: z.object({
      query: z
        .string()
        .trim()
        .min(1)
        .describe("Read-only query in the provider's dialect (e.g. SELECT/WITH for sqlite)"),
      params: AdminParamsInput,
    }),
  }, async ({ query, params }) => {
    return jsonResult(admin.search(query, params ?? []));
  });

  server.registerTool("admin_execute", {
    title: "Execute storage statement",
    description:
      "Run a single mutating statement against octo-santa's storage layer, applied atomically. " +
      "Elevated access: no messaging-level checks apply. " +
      `Read the ${ADMIN_TYPEHEAD_URI} resource for schema and delivery invariants.`,
    // destructiveHint: arbitrary statements can update or delete existing data.
    annotations: { ...LOCAL, readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    outputSchema: ExecuteOutput,
    inputSchema: z.object({
      statement: z
        .string()
        .trim()
        .min(1)
        .describe("One mutating statement in the provider's dialect (no BEGIN/COMMIT — it is wrapped)"),
      params: AdminParamsInput,
    }),
  }, async ({ statement, params }) => {
    return jsonResult(admin.execute(statement, params ?? []));
  });
}

// The typehead is a resource, not a tool: it is static reference material the
// client fetches once, and keeping the tool surface at exactly search +
// execute is the point of the code-mode design.
export function registerTypeheadResource(server: McpServer, admin: AdminService): void {
  server.registerResource(
    "admin-typehead",
    ADMIN_TYPEHEAD_URI,
    {
      title: "Storage typehead (.d.ts)",
      description:
        "TypeScript declaration file authored by the active storage provider: " +
        "table row shapes, search/execute contracts, and delivery invariants.",
      mimeType: "application/typescript",
    },
    async (uri) => {
      const description = admin.describe();
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/typescript",
            text: description.typehead,
          },
        ],
      };
    }
  );
}

export interface McpAdminStdioOpts {
  admin: AdminService;
}

// One server instance per stdio connection, same as the messaging transport —
// but with no per-connection state at all: no agent binding, no poller, no
// heartbeat. The admin plane is stateless request/response over the database.
function buildAdminConnectionServer(opts: McpAdminStdioOpts): McpServer {
  const mcpServer = new McpServer(
    { name: "octo-santa-admin", version: pkg.version },
    { instructions: buildAdminInstructions(opts.admin) }
  );

  registerAdminTools(mcpServer, opts.admin);
  registerTypeheadResource(mcpServer, opts.admin);

  return mcpServer;
}

export function startAdminMcpStdio(opts: McpAdminStdioOpts): StdioServerHandle {
  const handle = serveStdio(() => buildAdminConnectionServer(opts), {
    onerror: (error) => log(`mcp admin stdio error: ${error}`),
  });

  log("octo-santa admin MCP server running");
  return handle;
}
