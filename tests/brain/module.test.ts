import { describe, it, expect, afterEach } from "bun:test";
import brain from "../../src/modules/brain";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";
import { messagingMigrations } from "../../src/modules/messaging/tools";
import { brainMigrations } from "../../src/modules/brain/tools";

const TEST_DB = testDbPath("brain-module");

afterEach(() => { cleanupDb(TEST_DB); });

describe("brain module", () => {
  it("exports the OctoModule interface", () => {
    expect(brain.name).toBe("brain");
    expect(brain.migrations).toBeArray();
    expect(brain.migrations.length).toBeGreaterThan(0);
    expect(typeof brain.registerTools).toBe("function");
    expect(typeof brain.onDisconnect).toBe("function");
  });

  it("registers the exact 6 brain tool names from the spec", () => {
    const db = setupTestDb(TEST_DB, [...messagingMigrations, ...brainMigrations]);
    const registeredTools: string[] = [];
    const mockServer = {
      registerTool: (name: string, ..._args: unknown[]) => {
        registeredTools.push(name);
      },
    } as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;

    brain.registerTools(mockServer, () => db);

    const expectedTools = [
      "brain_index",
      "brain_read",
      "brain_shared_index",
      "brain_shared_read",
      "brain_find_expert",
      "brain_claim_domain",
    ];
    expect(registeredTools.sort()).toEqual(expectedTools.sort());
  });
});
