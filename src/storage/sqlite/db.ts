import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

function isSqliteBusyError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes("database is locked") || msg.includes("sqlite_busy");
  }
  return false;
}

// Synchronous because bun:sqlite transactions require sync callers.
export function withRetrySync<T>(
  operation: () => T,
  maxRetries: number = 3,
  baseDelayMs: number = 100
): T {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (isSqliteBusyError(error) && attempt < maxRetries) {
        const delay = Math.min(
          baseDelayMs * Math.pow(2, attempt) + Math.random() * baseDelayMs,
          2000
        );
        Bun.sleepSync(delay);
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}

export function createDb(dbPath: string): Database {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath, { create: true });

  // busy_timeout must be set first: it is a connection-level setting that
  // cannot itself hit BUSY, and it enables SQLite's internal retry for
  // everything after it.
  db.run("PRAGMA busy_timeout = 5000");
  // Switching to WAL takes an exclusive lock the first time a DB is created,
  // so concurrent openers can get SQLITE_BUSY before busy_timeout applies.
  withRetrySync(() => db.run("PRAGMA journal_mode = WAL"), 10, 50);
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");

  return db;
}
