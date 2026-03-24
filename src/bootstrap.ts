// src/bootstrap.ts
import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { createDb } from "./db";
import { runMigrations } from "./migrations";
import messaging from "./modules/messaging";
import type { OctoModule } from "./types";

export const modules: OctoModule[] = [messaging];

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function openDb(): Database {
  const dbPath = expandHome(
    process.env.OCTO_SANTA_DB ?? join(homedir(), ".octo-santa", "messages.db")
  );
  const db = createDb(dbPath);
  const allMigrations = modules.flatMap((m) => m.migrations);
  runMigrations(db, allMigrations);
  return db;
}
