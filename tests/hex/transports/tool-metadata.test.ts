import { describe, it, expect, afterEach } from "bun:test";
import { cleanupDb, testDbPath, setupTestDb } from "../../helpers/db";
import { makeMockServer } from "../../helpers/mcp";
import { allMigrations } from "../../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../../src/storage/sqlite";
import { MessagingService } from "../../../src/core/messaging/service";
import { registerMessagingTools } from "../../../src/transports/mcp-stdio/adapter";

const TEST_DB = testDbPath("tool-metadata");

afterEach(() => {
  cleanupDb(TEST_DB);
});

const ALL_TOOLS = [
  "messaging_register",
  "messaging_create_channel",
  "messaging_subscribe",
  "messaging_list_channels",
  "messaging_send",
  "messaging_read_messages",
  "messaging_list_agents",
  "messaging_list_members",
  "messaging_rename_channel",
];

const READ_ONLY_TOOLS = new Set([
  "messaging_list_channels",
  "messaging_list_agents",
  "messaging_list_members",
]);

function setup() {
  const db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(repos.agents, repos.channels, repos.messages, process.pid);

  const { server, configs, invoke } = makeMockServer();
  registerMessagingTools(server, svc);
  return { db, configs, invoke };
}

describe("tool metadata (SDK v2)", () => {
  it("every tool declares title, description, annotations, and outputSchema", () => {
    const { db, configs } = setup();
    expect(Object.keys(configs).sort()).toEqual([...ALL_TOOLS].sort());
    for (const name of ALL_TOOLS) {
      const config = configs[name];
      expect(config.title, `${name} title`).toBeTruthy();
      expect(config.description, `${name} description`).toBeTruthy();
      expect(config.outputSchema, `${name} outputSchema`).toBeDefined();
      expect(config.annotations, `${name} annotations`).toBeDefined();
    }
    db.close();
  });

  it("annotations mark octo-santa as a closed-world local system", () => {
    const { db, configs } = setup();
    for (const name of ALL_TOOLS) {
      expect(configs[name].annotations.openWorldHint, `${name} openWorldHint`).toBe(false);
      // Nothing in octo-santa destroys data — sends, joins, and renames are additive.
      expect(configs[name].annotations.destructiveHint ?? false, `${name} destructiveHint`).toBe(false);
    }
    db.close();
  });

  it("readOnlyHint is true exactly for the pure list tools", () => {
    const { db, configs } = setup();
    for (const name of ALL_TOOLS) {
      expect(configs[name].annotations.readOnlyHint, `${name} readOnlyHint`).toBe(
        READ_ONLY_TOOLS.has(name)
      );
    }
    db.close();
  });

  it("messaging_read_messages is NOT readOnly (default mode consumes the unread cursor)", () => {
    const { db, configs } = setup();
    expect(configs.messaging_read_messages.annotations.readOnlyHint).toBe(false);
    db.close();
  });
});

describe("structured output contract", () => {
  // Runs every tool against the real service and validates structuredContent
  // with the exact zod schema each tool advertises — the runtime drift guard
  // between core return shapes and the wire contract.
  it("every tool's real result parses against its declared outputSchema", async () => {
    const { db, invoke } = setup();

    await invoke("messaging_register", { agent_id: "meta-agent" });
    await invoke("messaging_create_channel", { agent_id: "meta-agent", name: "meta-ch" });
    await invoke("messaging_create_channel", { agent_id: "meta-agent", name: "meta-ch2" });
    await invoke("messaging_subscribe", { agent_id: "meta-agent", channel: "meta-ch2" });
    await invoke("messaging_send", { agent_id: "meta-agent", channel: "meta-ch", content: "hello meta" });
    await invoke("messaging_read_messages", { agent_id: "meta-agent", channel: "meta-ch" });
    await invoke("messaging_list_channels", {});
    await invoke("messaging_list_agents", {});
    const members = await invoke("messaging_list_members", { channel: "meta-ch" });
    expect(members.members).toHaveLength(1);
    await invoke("messaging_rename_channel", {
      agent_id: "meta-agent",
      channel: "meta-ch",
      new_name: "meta-renamed",
    });

    db.close();
  });
});
