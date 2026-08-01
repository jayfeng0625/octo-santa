import { describe, it, expect, afterEach } from "bun:test";
import { cleanupDb, testDbPath, setupTestDb } from "../../helpers/db";
import { allMigrations } from "../../../src/storage/sqlite/migrations";
import { SqliteAdminGateway } from "../../../src/storage/sqlite/admin-gateway";
import { AdminService } from "../../../src/core/admin/service";
import {
  registerAdminTools,
  registerTypeheadResource,
  buildAdminInstructions,
  ADMIN_TYPEHEAD_URI,
} from "../../../src/transports/mcp-admin-stdio/adapter";
import { SQLITE_ADMIN_TYPEHEAD } from "../../../src/storage/sqlite/admin-typehead";

const TEST_DB = testDbPath("admin-tool-metadata");

afterEach(() => {
  cleanupDb(TEST_DB);
});

function setup() {
  const db = setupTestDb(TEST_DB, allMigrations);
  const admin = new AdminService(new SqliteAdminGateway(db));

  const configs: Record<string, any> = {};
  const handlers: Record<string, (...args: any[]) => Promise<any>> = {};
  const resources: Record<string, { uri: string; config: any; read: (uri: URL) => Promise<any> }> = {};
  const mockServer = {
    registerTool: (name: string, config: any, cb: (...args: any[]) => Promise<any>) => {
      configs[name] = config;
      handlers[name] = cb;
    },
    registerResource: (name: string, uri: string, config: any, read: (uri: URL) => Promise<any>) => {
      resources[name] = { uri, config, read };
    },
  } as any;

  registerAdminTools(mockServer, admin);
  registerTypeheadResource(mockServer, admin);
  return { db, admin, configs, handlers, resources };
}

describe("admin plane tool surface", () => {
  it("exposes exactly search and execute — nothing else", () => {
    const { db, configs } = setup();
    expect(Object.keys(configs).sort()).toEqual(["admin_execute", "admin_search"]);
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
  it("serves the provider's .d.ts at the advertised URI", async () => {
    const { db, resources } = setup();
    const resource = resources["admin-typehead"]!;
    expect(resource.uri).toBe(ADMIN_TYPEHEAD_URI);
    expect(resource.config.mimeType).toBe("application/typescript");
    const result = await resource.read(new URL(ADMIN_TYPEHEAD_URI));
    expect(result.contents[0].text).toBe(SQLITE_ADMIN_TYPEHEAD);
    expect(result.contents[0].mimeType).toBe("application/typescript");
    db.close();
  });

  it("instructions stay under Claude Code's 2KB limit and point at the typehead", () => {
    const { db, admin } = setup();
    const instructions = buildAdminInstructions(admin);
    expect(instructions.length).toBeLessThan(2048);
    expect(instructions).toContain(ADMIN_TYPEHEAD_URI);
    db.close();
  });
});

describe("structured output contract", () => {
  it("real search/execute results parse against the declared outputSchemas", async () => {
    const { db, configs, handlers } = setup();

    const invoke = async (name: string, args: Record<string, unknown>) => {
      const result = await handlers[name]!(args);
      const parsed = configs[name].outputSchema.safeParse(result.structuredContent);
      expect(
        parsed.success,
        `${name} structuredContent vs outputSchema: ${JSON.stringify(parsed.error?.issues)}`
      ).toBe(true);
      expect(result.content[0].text).toBe(JSON.stringify(result.structuredContent));
      return result.structuredContent;
    };

    const inserted = await invoke("admin_execute", {
      statement:
        "INSERT INTO channels (name, created_by, created_at) VALUES (?, '_system', ?)",
      params: ["wire-check", 123],
    });
    expect(inserted.changes).toBe(1);

    const searched = await invoke("admin_search", {
      query: "SELECT name, created_at FROM channels WHERE name = ?",
      params: ["wire-check"],
    });
    expect(searched.rows).toEqual([{ name: "wire-check", created_at: 123 }]);
    expect(searched.truncated).toBe(false);

    db.close();
  });
});
