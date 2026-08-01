import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import type { AdminService } from "../../core/admin/service";
import { log } from "../../log";
import { jsonResult, LOCAL } from "../mcp-stdio/helpers";
import { RunOutput } from "./schemas";
import pkg from "../../../package.json";

export const ADMIN_TYPEHEAD_URI = "octo-santa://admin/typehead.d.ts";

// Core names the two operations; binding them to MCP tool names is this
// adapter's job, so the served document says which tool runs which.
const TOOL_MAPPING_NOTE = `
// Running this API over MCP: the \`admin_search\` tool performs a read-only
// run, and the \`admin_execute\` tool performs a read/write run.
`;

// Claude Code truncates server instructions at 2KB — keep this text under
// that limit. Deliberately brief on the execution model: the typehead
// resource is the single source for that, and this points at it.
export function buildAdminInstructions(admin: AdminService): string {
  const { modules, language } = admin.describe();
  const moduleList = modules.map((m) => `${m.globalName} (${m.provider})`).join(", ");
  return (
    "octo-santa ADMIN API: elevated access for approved apps — issue-tracker " +
    "bridges pushing events to channels and agents, reporting over message " +
    "history — without going through the chat-style messaging tools.\n\n" +
    `Two tools, and both take ${language} code rather than a query:\n` +
    "- admin_search: runs your code with each module's READ-ONLY methods.\n" +
    "- admin_execute: runs your code with every method, including writes.\n\n" +
    "Your code is an async function body: use await, then `return` a JSON " +
    "value — that value, plus anything you logged with console, is the " +
    "result. Do the filtering and counting inside your code and return only " +
    "what you need. Imports do not work; the modules are already global " +
    "variables: " + moduleList + ".\n\n" +
    `START by reading resource ${ADMIN_TYPEHEAD_URI} — the type declarations ` +
    "for those globals. Each module declares its own record shapes and its " +
    "read and write methods. Underlying storage (SQL and the like) is never " +
    "exposed; the methods uphold the system's rules for you."
  );
}

export function registerAdminTools(server: McpServer, admin: AdminService): void {
  const language = admin.describe().language;

  server.registerTool("admin_search", {
    title: "Run read-only code",
    description:
      `Run ${language} against the modules' read-only methods (async function body; ` +
      "`return` a JSON value). Nothing bound into this run can change data. " +
      `Read the ${ADMIN_TYPEHEAD_URI} resource for the available methods.`,
    annotations: { ...LOCAL, readOnlyHint: true, idempotentHint: true },
    outputSchema: RunOutput,
    inputSchema: z.object({
      code: z
        .string()
        .trim()
        .min(1)
        .describe(
          `${language}, run as an async function body with the read-only module methods as globals`
        ),
    }),
  }, async ({ code }) => {
    return jsonResult(await admin.search(code));
  });

  server.registerTool("admin_execute", {
    title: "Run code with write access",
    description:
      `Run ${language} against every module method, including the ones that ` +
      "change data (async function body; `return` a JSON value). Elevated " +
      "access: the messaging-level permission checks do not apply. " +
      `Read the ${ADMIN_TYPEHEAD_URI} resource for the available methods.`,
    annotations: { ...LOCAL, readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    outputSchema: RunOutput,
    inputSchema: z.object({
      code: z
        .string()
        .trim()
        .min(1)
        .describe(
          `${language}, run as an async function body with every module method as globals`
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
      title: "Admin API type declarations (.d.ts)",
      description:
        "TypeScript declarations for the globals available in admin_search / " +
        "admin_execute code: each module's record shapes and its read and write methods.",
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
