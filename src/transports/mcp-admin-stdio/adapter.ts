import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import type { AdminService } from "../../core/admin/service";
import { log } from "../../log";
import { RunOutput } from "./schemas";
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
  const { modules } = admin.describe();
  const moduleList = modules.map((m) => `${m.module} (${m.provider})`).join(", ");
  return (
    "octo-santa ADMIN plane: an elevated, code-mode integration surface for " +
    "approved apps — issue-tracker bridges pushing events to channels and " +
    "agents, analytics over message history — without going through the " +
    "chat-style messaging tools.\n\n" +
    "Exactly two tools; both take TypeScript code, not queries:\n" +
    "- admin_search: runs your code with each module's READ-ONLY API bound.\n" +
    "- admin_execute: runs your code with each module's full API bound.\n\n" +
    "Code runs as the body of an async function: use await, then `return` a " +
    "JSON value — that value (plus captured console output) is the tool " +
    "result. Do heavy filtering/aggregation in code and return only what you " +
    "need. No imports; modules are pre-bound globals: " + moduleList + ".\n\n" +
    `START by reading resource ${ADMIN_TYPEHEAD_URI} — the composed TypeScript ` +
    ".d.ts typehead. Each module authors its own fragment declaring its " +
    "record shapes and its search/execute API surfaces; raw backends (SQL " +
    "etc.) are never exposed, only controlled methods that uphold the " +
    "system's invariants."
  );
}

export function registerAdminTools(server: McpServer, admin: AdminService): void {
  server.registerTool("admin_search", {
    title: "Run read-only TypeScript",
    description:
      "Run TypeScript against the read-only module APIs (async function body; " +
      "`return` a JSON value). Nothing bound into this run can mutate state. " +
      `Read the ${ADMIN_TYPEHEAD_URI} resource for the typed API surface.`,
    annotations: { ...LOCAL, readOnlyHint: true, idempotentHint: true },
    outputSchema: RunOutput,
    inputSchema: z.object({
      code: z
        .string()
        .trim()
        .min(1)
        .describe(
          "TypeScript, run as an async function body with read-only module APIs bound as globals"
        ),
    }),
  }, async ({ code }) => {
    return jsonResult(await admin.search(code));
  });

  server.registerTool("admin_execute", {
    title: "Run TypeScript with write access",
    description:
      "Run TypeScript against the full module APIs, including controlled write " +
      "methods (async function body; `return` a JSON value). Elevated access: " +
      "no messaging-level checks apply. " +
      `Read the ${ADMIN_TYPEHEAD_URI} resource for the typed API surface.`,
    // destructiveHint: submitted code can call methods that change state.
    annotations: { ...LOCAL, readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    outputSchema: RunOutput,
    inputSchema: z.object({
      code: z
        .string()
        .trim()
        .min(1)
        .describe(
          "TypeScript, run as an async function body with full module APIs bound as globals"
        ),
    }),
  }, async ({ code }) => {
    return jsonResult(await admin.execute(code));
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
      title: "Admin API typehead (.d.ts)",
      description:
        "Composed TypeScript declaration file: core's execution model plus " +
        "each module's typed API surface for admin_search / admin_execute code.",
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
