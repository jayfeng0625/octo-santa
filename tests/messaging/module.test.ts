import { describe, it, expect } from "bun:test";
import messaging from "../../src/modules/messaging";

describe("messaging module", () => {
  it("exports the OctoModule interface", () => {
    expect(messaging.name).toBe("messaging");
    expect(messaging.migrations).toBeArray();
    expect(messaging.migrations.length).toBeGreaterThan(0);
    expect(typeof messaging.registerTools).toBe("function");
  });

  it("registers the exact MCP tool names from the spec", () => {
    const registeredTools: string[] = [];
    const mockServer = {
      registerTool: (name: string, ..._args: unknown[]) => {
        registeredTools.push(name);
      },
    } as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;

    messaging.registerTools(mockServer, () => null as any);

    const expectedTools = [
      "messaging_register",
      "messaging_create_channel",
      "messaging_list_channels",
      "messaging_send_message",
      "messaging_subscribe",
      "messaging_read_messages",
      "messaging_list_agents",
      "messaging_list_members",
    ];
    expect(registeredTools.sort()).toEqual(expectedTools.sort());
  });
});
