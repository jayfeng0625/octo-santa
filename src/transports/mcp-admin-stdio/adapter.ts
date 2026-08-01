import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import type { AdminService } from "../../core/admin/service";
import { log } from "../../log";
import { jsonResult, LOCAL } from "../mcp-stdio/helpers";
import { SearchOutput, ExecuteOutput } from "./schemas";
import pkg from "../../../package.json";

export const ADMIN_TYPEHEAD_URI = "octo-santa://admin/typehead.d.ts";

// Core names the two operations; binding them to MCP tool names is this
// adapter's job, so the served document says which tool does which.
const TOOL_MAPPING_NOTE = `
// Using this API over MCP: the \`admin_search\` tool searches these
// declarations by keyword, and the \`admin_execute\` tool runs your code.
`;

// Claude Code truncates server instructions at 2KB — keep this text under
// that limit.
export function buildAdminInstructions(admin: AdminService): string {
  const { modules, language } = admin.describe();
  const moduleList = modules.map((m) => `${m.globalName} (${m.provider})`).join(", ");
  return (
    "octo-santa ADMIN API: elevated access for approved apps — issue-tracker " +
    "bridges pushing events to channels and agents, reporting over message " +
    "history — without going through the chat-style messaging tools.\n\n" +
    "Two tools, code-mode style:\n" +
    "- admin_search: find what to call. Searches the modules' typed API " +
    "declarations by keyword and returns the matching methods and types " +
    "with their docs — so you pull in only what you need.\n" +
    `- admin_execute: run ${language} code against those APIs.\n\n` +
    "Typical flow: search for what you want to do (e.g. \"send message\"), " +
    "read the declarations that come back, then execute code that calls " +
    "them. Your code is an async function body: use await, then `return` a " +
    "JSON value — that value, plus anything you logged with console, is the " +
    "result. Do the filtering and counting inside your code and return only " +
    "what you need. Imports do not work; the modules are already global " +
    "variables: " + moduleList + ".\n\n" +
    `The full declarations are also readable as resource ${ADMIN_TYPEHEAD_URI}. ` +
    "Underlying storage (SQL and the like) is never exposed; the methods " +
    "uphold the system's rules for you."
  );
}

export function registerAdminTools(server: McpServer, admin: AdminService): void {
  const language = admin.describe().language;

  server.registerTool("admin_search", {
    title: "Find methods to call",
    description:
      "Search the admin API's typed declarations by keyword. Returns the " +
      "matching methods and types with their docs — use this to discover what " +
      "to call and how before writing code for admin_execute. " +
      `The full document is resource ${ADMIN_TYPEHEAD_URI}.`,
    annotations: { ...LOCAL, readOnlyHint: true, idempotentHint: true },
    outputSchema: SearchOutput,
    inputSchema: z.object({
      query: z
        .string()
        .trim()
        .min(1)
        .describe('What you want to do, as keywords — e.g. "send message channel"'),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max declarations to return (default 10)"),
    }),
  }, async ({ query, limit }) => {
    return jsonResult(admin.search(query, limit));
  });

  server.registerTool("admin_execute", {
    title: "Run code",
    description:
      `Run ${language} against the module APIs (async function body; ` +
      "`return` a JSON value). Elevated access: the messaging-level " +
      "permission checks do not apply. Use admin_search first to find the " +
      "methods to call.",
    // destructiveHint: submitted code can call methods that change data.
    annotations: { ...LOCAL, readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    outputSchema: ExecuteOutput,
    inputSchema: z.object({
      code: z
        .string()
        .trim()
        .min(1)
        .describe(
          `${language}, run as an async function body with the module APIs as globals`
        ),
    }),
  }, async ({ code }) => {
    return jsonResult(await admin.execute(code));
  });
}

// The full typehead is a resource, not a tool: it is static reference
// material for clients that want the whole contract up front (e.g. to
// typecheck an integration against), while admin_search serves the
// progressive path.
export function registerTypeheadResource(server: McpServer, admin: AdminService): void {
  server.registerResource(
    "admin-typehead",
    ADMIN_TYPEHEAD_URI,
    {
      title: "Admin API type declarations (.d.ts)",
      description:
        "The complete TypeScript declarations behind admin_search / " +
        "admin_execute: each module's record shapes and methods.",
      mimeType: "application/typescript",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "application/typescript",
          text: admin.describe().typehead + TOOL_MAPPING_NOTE,
        },
      ],
    })
  );
}

export interface McpAdminStdioOpts {
  admin: AdminService;
}

// One server instance per stdio connection, same as the messaging transport —
// but with no per-connection state at all: no agent binding, no poller, no
// heartbeat. The admin API is stateless request/response over the database.
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
