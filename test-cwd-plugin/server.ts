import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "test-cwd", version: "0.0.1" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "check_cwd",
      description: "Returns process.cwd() and related path info",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [
    {
      type: "text",
      text: JSON.stringify(
        {
          cwd: process.cwd(),
          plugin_root: process.env.CLAUDE_PLUGIN_ROOT ?? "(not set)",
          plugin_data: process.env.CLAUDE_PLUGIN_DATA ?? "(not set)",
          argv: process.argv,
        },
        null,
        2
      ),
    },
  ],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
