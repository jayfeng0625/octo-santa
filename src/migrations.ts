import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { withRetrySync } from "./db";

export interface Migration {
  name: string;
  up: string;
}

export interface MigrationResult {
  applied: string[];
  driftDetected: string[];
}

function computeChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf-8").digest("hex");
}

export function runMigrations(db: Database, migrations: Migration[]): MigrationResult {
  const sorted = [...migrations].sort((a, b) => a.name.localeCompare(b.name));

  // Validate no duplicate names
  const names = sorted.map((m) => m.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length > 0) {
    throw new Error(`Duplicate migration names: ${[...new Set(dupes)].join(", ")}`);
  }

  return withRetrySync(() => {
    db.run("BEGIN EXCLUSIVE");

    try {
      // Bootstrap: create tracking table if it doesn't exist
      db.run(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name TEXT PRIMARY KEY,
          checksum TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        )
      `);

      // One-time migration from PRAGMA user_version (for existing DBs)
      const pragmaVersion = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (pragmaVersion > 0) {
        const existingCount = (db.query("SELECT COUNT(*) as count FROM schema_migrations").get() as { count: number }).count;
        if (existingCount === 0) {
          // Seed all migrations up to the pragma version as already applied
          for (const m of sorted) {
            db.run(
              "INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)",
              [m.name, computeChecksum(m.up), Date.now()]
            );
          }
          db.run("PRAGMA user_version = 0");
          db.run("COMMIT");
          return { applied: [], driftDetected: [] };
        }
      }

      const applied = db.query("SELECT name, checksum FROM schema_migrations").all() as { name: string; checksum: string }[];
      const appliedMap = new Map(applied.map((r) => [r.name, r.checksum]));

      const result: MigrationResult = { applied: [], driftDetected: [] };

      for (const migration of sorted) {
        const existingChecksum = appliedMap.get(migration.name);

        if (existingChecksum !== undefined) {
          // Already applied — validate checksum
          const currentChecksum = computeChecksum(migration.up);
          if (existingChecksum !== currentChecksum) {
            result.driftDetected.push(migration.name);
          }
          continue;
        }

        // Apply migration
        db.run(migration.up);
        db.run(
          "INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)",
          [migration.name, computeChecksum(migration.up), Date.now()]
        );
        result.applied.push(migration.name);
      }

      db.run("COMMIT");
      return result;

    } catch (error) {
      try { db.run("ROLLBACK"); } catch {}
      throw error;
    }
  });
}
