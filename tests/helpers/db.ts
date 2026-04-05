import { existsSync, unlinkSync } from "fs";
import type { Database } from "bun:sqlite";
import { createDb } from "../../src/storage/sqlite/db";
import { runMigrations, type Migration } from "../../src/storage/sqlite/migrations";

export function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = path + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
}

export function testDbPath(name: string): string {
  return `/tmp/octo-santa-test-${name}-${process.pid}.sqlite`;
}

export function setupTestDb(path: string, migrations: Migration[]): Database {
  cleanupDb(path);
  const db = createDb(path);
  runMigrations(db, migrations);
  return db;
}
