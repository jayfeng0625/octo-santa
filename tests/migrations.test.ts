import { describe, it, expect, afterEach } from "bun:test";
import { createDb } from "../src/storage/sqlite/db";
import { runMigrations, allMigrations, type Migration } from "../src/storage/sqlite/migrations";
import { cleanupDb, testDbPath } from "./helpers/db";

const TEST_DB = testDbPath("migrations");

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("name-based migrations", () => {
  it("applies migrations and records them in schema_migrations", () => {
    cleanupDb(TEST_DB);
    const db = createDb(TEST_DB);

    const migrations: Migration[] = [
      { name: "test_001_create_foo", up: "CREATE TABLE foo (id INTEGER PRIMARY KEY)" },
      { name: "test_002_create_bar", up: "CREATE TABLE bar (id INTEGER PRIMARY KEY)" },
    ];

    const result = runMigrations(db, migrations);

    expect(result.applied).toEqual(["test_001_create_foo", "test_002_create_bar"]);
    expect(result.driftDetected).toEqual([]);

    const rows = db.query("SELECT name FROM schema_migrations ORDER BY name").all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(["test_001_create_foo", "test_002_create_bar"]);

    // Tables actually created
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('foo','bar') ORDER BY name").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(["bar", "foo"]);

    db.close();
  });

  it("skips already-applied migrations", () => {
    cleanupDb(TEST_DB);
    const db = createDb(TEST_DB);

    const migrations: Migration[] = [
      { name: "test_001_create_foo", up: "CREATE TABLE foo (id INTEGER PRIMARY KEY)" },
    ];

    runMigrations(db, migrations);
    const result = runMigrations(db, migrations);

    expect(result.applied).toEqual([]);
    db.close();
  });

  it("applies only new migrations on second run", () => {
    cleanupDb(TEST_DB);
    const db = createDb(TEST_DB);

    const v1: Migration[] = [
      { name: "test_001_create_foo", up: "CREATE TABLE foo (id INTEGER PRIMARY KEY)" },
    ];
    runMigrations(db, v1);

    const v2: Migration[] = [
      ...v1,
      { name: "test_002_create_bar", up: "CREATE TABLE bar (id INTEGER PRIMARY KEY)" },
    ];
    const result = runMigrations(db, v2);

    expect(result.applied).toEqual(["test_002_create_bar"]);
    db.close();
  });

  it("detects drift when migration content changes", () => {
    cleanupDb(TEST_DB);
    const db = createDb(TEST_DB);

    const original: Migration[] = [
      { name: "test_001_create_foo", up: "CREATE TABLE foo (id INTEGER PRIMARY KEY)" },
    ];
    runMigrations(db, original);

    const modified: Migration[] = [
      { name: "test_001_create_foo", up: "CREATE TABLE foo (id INTEGER PRIMARY KEY, name TEXT)" },
    ];
    const result = runMigrations(db, modified);

    expect(result.driftDetected).toEqual(["test_001_create_foo"]);
    db.close();
  });

  it("rejects duplicate migration names", () => {
    cleanupDb(TEST_DB);
    const db = createDb(TEST_DB);

    const migrations: Migration[] = [
      { name: "test_001_create_foo", up: "CREATE TABLE foo (id INTEGER PRIMARY KEY)" },
      { name: "test_001_create_foo", up: "CREATE TABLE bar (id INTEGER PRIMARY KEY)" },
    ];

    expect(() => runMigrations(db, migrations)).toThrow("Duplicate migration names");
    db.close();
  });

  it("supports multi-module migrations without collision", () => {
    cleanupDb(TEST_DB);
    const db = createDb(TEST_DB);

    const messagingMigrations: Migration[] = [
      { name: "messaging_001_initial", up: "CREATE TABLE agents (id TEXT PRIMARY KEY)" },
    ];
    const brainMigrations: Migration[] = [
      { name: "brain_001_initial", up: "CREATE TABLE knowledge (id TEXT PRIMARY KEY)" },
    ];

    const all = [...messagingMigrations, ...brainMigrations];
    const result = runMigrations(db, all);

    expect(result.applied.sort()).toEqual(["brain_001_initial", "messaging_001_initial"]);

    const agents = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='agents'").get();
    const knowledge = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge'").get();
    expect(agents).not.toBeNull();
    expect(knowledge).not.toBeNull();

    db.close();
  });

  it("bootstraps from PRAGMA user_version for existing DBs", () => {
    cleanupDb(TEST_DB);
    const db = createDb(TEST_DB);

    // Simulate an existing DB with pragma-based versioning
    db.run("CREATE TABLE agents (id TEXT PRIMARY KEY, created_at INTEGER, last_seen_at INTEGER)");
    db.run("PRAGMA user_version = 1");

    const migrations: Migration[] = [
      { name: "messaging_001_initial_schema", up: "CREATE TABLE agents (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL)" },
    ];

    const result = runMigrations(db, migrations);

    // Should seed existing migration as applied, not re-run it
    expect(result.applied).toEqual([]);
    const pragma = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(pragma).toBe(0); // Reset after bootstrap

    const recorded = db.query("SELECT name FROM schema_migrations").all() as { name: string }[];
    expect(recorded.length).toBe(1);
    expect(recorded[0]!.name).toBe("messaging_001_initial_schema");

    db.close();
  });

  it("upgrades legacy DB: seeds v1 as applied, runs v2 migration", () => {
    cleanupDb(TEST_DB);
    const db = createDb(TEST_DB);

    // Simulate a legacy v1 DB (has the first migration's schema via pragma)
    db.run("CREATE TABLE agents (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL)");
    db.run("CREATE TABLE channels (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL)");
    db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER NOT NULL, agent_id TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)");
    db.run("CREATE TABLE cursors (agent_id TEXT NOT NULL, channel_id INTEGER NOT NULL, last_read_message_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (agent_id, channel_id))");
    db.run("PRAGMA user_version = 1");

    const migrations: Migration[] = [
      { name: "messaging_001_initial_schema", up: "CREATE TABLE agents (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL)" },
      { name: "messaging_002_mentions_and_pid", up: "ALTER TABLE agents ADD COLUMN pid INTEGER; ALTER TABLE agents ADD COLUMN registered_at INTEGER; ALTER TABLE messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]';" },
    ];

    const result = runMigrations(db, migrations);

    // v1 should be seeded as applied, v2 should actually run
    expect(result.applied).toEqual(["messaging_002_mentions_and_pid"]);

    // Verify v2 columns exist
    const agentCols = db.query("PRAGMA table_info(agents)").all() as { name: string }[];
    const colNames = agentCols.map(c => c.name);
    expect(colNames).toContain("pid");
    expect(colNames).toContain("registered_at");

    const msgCols = db.query("PRAGMA table_info(messages)").all() as { name: string }[];
    expect(msgCols.map(c => c.name)).toContain("mentions");

    db.close();
  });
});

// I2 — Gap#2: messaging_007 adds the `subscribed` membership flag to cursors via a
// plain ADD COLUMN. cursors is an FK CHILD (no table rebuild, no foreign_keys=OFF), so
// the FK-parent rebuild landmine does not apply — but we still prove it COMMITs cleanly
// against a POPULATED db and backfills existing rows to 1.
describe("messaging_007 subscribed membership column (I2)", () => {
  const M007 = "messaging_007_membership_subscribed";

  it("adds `subscribed` to a populated cursors table and backfills existing rows to 1", () => {
    cleanupDb(TEST_DB);
    const db = createDb(TEST_DB);

    // Migrate everything EXCEPT 007, then populate a member (cursor row).
    const pre007 = allMigrations.filter((m) => m.name !== M007);
    runMigrations(db, pre007);
    db.run("INSERT INTO agents (id, created_at, last_seen_at) VALUES ('agent-a', 0, 0)");
    db.run(
      "INSERT INTO channels (name, created_by, created_at) VALUES ('general', 'agent-a', 0)"
    );
    const chId = (db.query("SELECT id FROM channels WHERE name = 'general'").get() as {
      id: number;
    }).id;
    db.run(
      "INSERT INTO cursors (agent_id, channel_id, last_read_message_id) VALUES ('agent-a', ?, 0)",
      [chId]
    );

    // Now apply 007 against the POPULATED db — must COMMIT cleanly.
    const result = runMigrations(db, allMigrations);
    expect(result.applied).toContain(M007);
    expect(result.driftDetected).toEqual([]);

    const cols = (db.query("PRAGMA table_info(cursors)").all() as { name: string }[]).map(
      (c) => c.name
    );
    expect(cols).toContain("subscribed");

    // Existing row backfilled to 1 (current members stay members).
    const row = db
      .query("SELECT subscribed FROM cursors WHERE agent_id = 'agent-a' AND channel_id = ?")
      .get(chId) as { subscribed: number };
    expect(row.subscribed).toBe(1);

    db.close();
  });
});
