import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { createDb } from "../src/db";
import { runMigrations, type Migration } from "../src/migrations";

const TEST_DB = `/tmp/octo-santa-test-migrations-${process.pid}.sqlite`;

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = path + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
}

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
});
