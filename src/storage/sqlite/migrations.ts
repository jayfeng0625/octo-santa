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
          // Seed only migrations up to the pragma version as already applied
          const alreadyApplied = sorted.slice(0, pragmaVersion);
          for (const m of alreadyApplied) {
            db.run(
              "INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)",
              [m.name, computeChecksum(m.up), Date.now()]
            );
          }
          db.run("PRAGMA user_version = 0");
          db.run("COMMIT");
          // Re-run to apply any migrations beyond the pragma version
          return runMigrations(db, migrations);
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

const messagingMigrations: Migration[] = [
  {
    name: "messaging_001_initial_schema",
    up: `
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        created_by TEXT NOT NULL REFERENCES agents(id),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER NOT NULL REFERENCES channels(id),
        agent_id TEXT NOT NULL REFERENCES agents(id),
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_messages_channel_id ON messages(channel_id, id, agent_id);
      CREATE TABLE cursors (
        agent_id TEXT NOT NULL REFERENCES agents(id),
        channel_id INTEGER NOT NULL REFERENCES channels(id),
        last_read_message_id INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, channel_id)
      );
    `,
  },
  {
    name: "messaging_002_mentions_and_pid",
    up: `
      ALTER TABLE agents ADD COLUMN pid INTEGER;
      ALTER TABLE agents ADD COLUMN registered_at INTEGER;
      ALTER TABLE messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    name: "messaging_003_agent_profiles",
    up: `
      ALTER TABLE agents ADD COLUMN base_name TEXT;
      ALTER TABLE agents ADD COLUMN persona TEXT;
      ALTER TABLE agents ADD COLUMN objective TEXT;
      CREATE INDEX idx_agents_base_name ON agents(base_name);
    `,
  },
  {
    name: "messaging_004_agent_instructions",
    up: `
      ALTER TABLE agents ADD COLUMN instructions TEXT;
    `,
  },
];

const brainMigrations: Migration[] = [
  {
    name: "brain_001_domains_and_claims",
    up: `
      CREATE TABLE domains (
        identifier TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        tags TEXT NOT NULL,
        description TEXT NOT NULL,
        registered_at INTEGER NOT NULL
      );
      CREATE TABLE domain_claims (
        agent_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        domain_identifier TEXT NOT NULL REFERENCES domains(identifier),
        claimed_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, pid)
      );
    `,
  },
];

const systemMigrations: Migration[] = [
  {
    name: "system_001_system_agent",
    up: `
      INSERT OR IGNORE INTO agents (id, created_at, last_seen_at)
      VALUES ('_system', 0, 0);
    `,
  },
];

export const allMigrations: Migration[] = [...messagingMigrations, ...brainMigrations, ...systemMigrations];
