import { describe, it, expect, afterEach } from "bun:test";
import { cleanupDb, testDbPath, setupTestDb } from "../../helpers/db";
import { makeMockServer } from "../../helpers/mcp";
import { allMigrations } from "../../../src/storage/sqlite/migrations";
import { SqliteAdminModule } from "../../../src/storage/sqlite/admin-module";
import { AdminService } from "../../../src/core/admin/service";
import { TypeScriptRunner } from "../../../src/runtime/typescript/runner";
import {
  registerAdminTools,
  registerTypeheadResource,
  buildAdminInstructions,
  ADMIN_TYPEHEAD_URI,
} from "../../../src/transports/mcp-admin-stdio/adapter";

const TEST_DB = testDbPath("admin-tool-metadata");

afterEach(() => {
  cleanupDb(TEST_DB);
});

function setup() {
  const db = setupTestDb(TEST_DB, allMigrations);
  const admin = new AdminService(new TypeScriptRunner(), [new SqliteAdminModule(db)]);

  const { server, configs, resources, invoke } = makeMockServer();
  registerAdminTools(server, admin);
  registerTypeheadResource(server, admin);
  return { db, admin, configs, resources, invoke };
}

describe("admin plane tool surface", () => {
  it("exposes exactly search and execute — nothing else", () => {
    const { db, configs } = setup();
    expect(Object.keys(configs).sort()).toEqual(["admin_execute", "admin_search"]);
    db.close();
  });

  it("both tools take code, not queries", () => {
    const { db, admin, configs } = setup();
    const language = admin.describe().language;
    for (const name of Object.keys(configs)) {
      const shape = configs[name].inputSchema.shape;
      expect(Object.keys(shape), `${name} input keys`).toEqual(["code"]);
      expect(configs[name].description, `${name} names the language`).toContain(language);
    }
    db.close();
  });

  it("every tool declares title, description, annotations, and outputSchema", () => {
    const { db, configs } = setup();
    for (const name of Object.keys(configs)) {
      expect(configs[name].title, `${name} title`).toBeTruthy();
      expect(configs[name].description, `${name} description`).toBeTruthy();
      expect(configs[name].outputSchema, `${name} outputSchema`).toBeDefined();
      expect(configs[name].annotations, `${name} annotations`).toBeDefined();
    }
    db.close();
  });

  it("search is read-only and closed-world; execute is destructive", () => {
    const { db, configs } = setup();
    expect(configs.admin_search.annotations.readOnlyHint).toBe(true);
    expect(configs.admin_search.annotations.openWorldHint).toBe(false);
    expect(configs.admin_execute.annotations.readOnlyHint).toBe(false);
    expect(configs.admin_execute.annotations.destructiveHint).toBe(true);
    expect(configs.admin_execute.annotations.openWorldHint).toBe(false);
    db.close();
  });
});

describe("typehead resource", () => {
  it("serves the composed .d.ts at the advertised URI", async () => {
    const { db, admin, resources } = setup();
    const resource = resources["admin-typehead"]!;
    expect(resource.uri).toBe(ADMIN_TYPEHEAD_URI);
    expect(resource.config.mimeType).toBe("application/typescript");
    const result = await resource.read(new URL(ADMIN_TYPEHEAD_URI));
    const text = result.contents[0].text as string;
    expect(text).toContain(admin.describe().typehead);
    expect(text).toContain("declare const storage");
    // Core stays out of MCP naming; the transport supplies the mapping.
    expect(admin.describe().typehead).not.toContain("admin_search");
    expect(text).toContain("`admin_search` tool performs a read-only");
    db.close();
  });

  it("instructions stay under Claude Code's 2KB limit and point at the typehead", () => {
    const { db, admin } = setup();
    const instructions = buildAdminInstructions(admin);
    expect(instructions.length).toBeLessThan(2048);
    expect(instructions).toContain(ADMIN_TYPEHEAD_URI);
    expect(instructions).toContain("storage (sqlite)");
    db.close();
  });
});

describe("structured output contract", () => {
  it("real code runs parse against the declared outputSchema", async () => {
    const { db, invoke } = setup();

    const executed = await invoke("admin_execute", {
      code: `
        const channel = storage.createChannelIfMissing("wire-check", "meta-bridge");
        console.log("created", channel.name);
        return { channelId: channel.id };
      `,
    });
    expect(executed.result.channelId).toBe(1);
    expect(executed.logs).toEqual(["[log] created wire-check"]);

    const searched = await invoke("admin_search", {
      code: `return storage.listChannels().map((c) => c.name);`,
    });
    expect(searched.result).toEqual(["wire-check"]);

    db.close();
  });
});
