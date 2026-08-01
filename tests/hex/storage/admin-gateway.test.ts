import { describe, it, expect, afterEach } from "bun:test";
import { cleanupDb, testDbPath, setupTestDb } from "../../helpers/db";
import { allMigrations } from "../../../src/storage/sqlite/migrations";
import { SqliteAdminGateway } from "../../../src/storage/sqlite/admin-gateway";

const TEST_DB = testDbPath("admin-gateway");

afterEach(() => {
  cleanupDb(TEST_DB);
});

function setup() {
  const db = setupTestDb(TEST_DB, allMigrations);
  return { db, gateway: new SqliteAdminGateway(db) };
}

describe("SqliteAdminGateway.describe", () => {
  it("identifies the sqlite provider and dialect", () => {
    const { db, gateway } = setup();
    const desc = gateway.describe();
    expect(desc.provider).toBe("sqlite");
    expect(desc.dialect).toBe("sqlite");
    db.close();
  });

  it("returns a typehead declaring every live table's row shape", () => {
    const { db, gateway } = setup();
    const typehead = gateway.describe().typehead;
    expect(typehead).toContain('declare module "octo-santa/admin"');
    for (const name of [
      "AgentRow",
      "ChannelRow",
      "MessageRow",
      "CursorRow",
      "SchemaMigrationRow",
      "OctoSantaAdmin",
    ]) {
      expect(typehead, `typehead declares ${name}`).toContain(`interface ${name}`);
    }
    db.close();
  });

  it("typehead row interfaces match the actual table columns", () => {
    // Drift guard: every column SELECT * can return must appear in the
    // typehead, so external apps compiling against it never miss a field.
    const { db, gateway } = setup();
    const typehead = gateway.describe().typehead;
    for (const table of ["agents", "channels", "messages", "cursors"]) {
      const cols = db
        .query(`SELECT name FROM pragma_table_info(?)`)
        .all(table) as { name: string }[];
      expect(cols.length).toBeGreaterThan(0);
      for (const { name } of cols) {
        expect(typehead, `typehead documents ${table}.${name}`).toContain(`${name}:`);
      }
    }
    db.close();
  });
});

describe("SqliteAdminGateway.search", () => {
  it("runs read-only queries with positional params", () => {
    const { db, gateway } = setup();
    gateway.execute(
      "INSERT INTO agents (id, created_at, last_seen_at) VALUES (?, ?, ?)",
      ["searcher", 100, 200]
    );
    const rows = gateway.search("SELECT id, created_at FROM agents WHERE id = ?", [
      "searcher",
    ]);
    expect(rows).toEqual([{ id: "searcher", created_at: 100 }]);
    db.close();
  });

  it("supports OLAP-style aggregation queries", () => {
    const { db, gateway } = setup();
    gateway.execute(
      "INSERT INTO channels (name, created_by, created_at) VALUES (?, ?, ?)",
      ["olap", "_system", 1]
    );
    for (let i = 0; i < 5; i++) {
      gateway.execute(
        "INSERT INTO messages (channel_id, agent_id, content, created_at, mentions) VALUES (1, '_system', ?, ?, '[]')",
        [`msg-${i}`, 1000 + i]
      );
    }
    const rows = gateway.search(
      "SELECT agent_id, COUNT(*) AS sent FROM messages GROUP BY agent_id"
    );
    expect(rows).toEqual([{ agent_id: "_system", sent: 5 }]);
    db.close();
  });

  it("rejects mutating statements", () => {
    const { db, gateway } = setup();
    expect(() =>
      gateway.search("DELETE FROM agents WHERE id = '_system'")
    ).toThrow();
    expect(() =>
      gateway.search("INSERT INTO agents (id, created_at, last_seen_at) VALUES ('x', 0, 0)")
    ).toThrow();
    // The seeded _system agent survives.
    const rows = gateway.search("SELECT COUNT(*) AS n FROM agents");
    expect(rows).toEqual([{ n: 1 }]);
    db.close();
  });

  it("leaves the connection writable after a rejected mutation", () => {
    const { db, gateway } = setup();
    expect(() => gateway.search("DELETE FROM agents")).toThrow();
    const result = gateway.execute(
      "INSERT INTO agents (id, created_at, last_seen_at) VALUES (?, 0, 0)",
      ["after-reject"]
    );
    expect(result.changes).toBe(1);
    db.close();
  });

  it("normalizes BLOB cells to base64 strings", () => {
    const { db, gateway } = setup();
    db.run("CREATE TABLE blobby (data BLOB)");
    db.run("INSERT INTO blobby VALUES (?)", [new Uint8Array([1, 2, 3])]);
    const rows = gateway.search("SELECT data FROM blobby");
    expect(rows).toEqual([{ data: Buffer.from([1, 2, 3]).toString("base64") }]);
    db.close();
  });
});

describe("SqliteAdminGateway.execute", () => {
  it("applies writes and reports changes and last_insert_row_id", () => {
    const { db, gateway } = setup();
    gateway.execute(
      "INSERT INTO agents (id, created_at, last_seen_at) VALUES (?, 0, 0)",
      ["writer"]
    );
    const insert = gateway.execute(
      "INSERT INTO channels (name, created_by, created_at) VALUES (?, ?, ?)",
      ["ch", "writer", 5]
    );
    expect(insert.changes).toBe(1);
    expect(insert.last_insert_row_id).toBe(1);

    const update = gateway.execute("UPDATE agents SET last_seen_at = 9 WHERE id != '_system'");
    expect(update.changes).toBe(1);
    db.close();
  });

  it("enforces foreign keys — a message from an unknown agent is rejected", () => {
    const { db, gateway } = setup();
    gateway.execute(
      "INSERT INTO channels (name, created_by, created_at) VALUES ('c', '_system', 0)"
    );
    expect(() =>
      gateway.execute(
        "INSERT INTO messages (channel_id, agent_id, content, created_at, mentions) VALUES (1, 'ghost', 'x', 0, '[]')"
      )
    ).toThrow();
    db.close();
  });

  it("surfaces SQL errors without corrupting later use of the connection", () => {
    const { db, gateway } = setup();
    expect(() => gateway.execute("UPDATE nope SET x = 1")).toThrow();
    const rows = gateway.search("SELECT COUNT(*) AS n FROM agents");
    expect(rows).toEqual([{ n: 1 }]);
    db.close();
  });
});
