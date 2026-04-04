import { describe, it, expect, afterEach } from "bun:test";
import { existsSync } from "fs";
import { createDb } from "../src/db";
import { cleanupDb, testDbPath } from "./helpers/db";

const TEST_DB = testDbPath("db");

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("createDb", () => {
  it("creates a database with WAL mode and busy timeout", () => {
    const db = createDb(TEST_DB);

    const walMode = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(walMode.journal_mode).toBe("wal");

    const busyTimeout = db.query("PRAGMA busy_timeout").get() as { timeout: number };
    expect(busyTimeout.timeout).toBe(5000);

    const synchronous = db.query("PRAGMA synchronous").get() as { synchronous: number };
    expect(synchronous.synchronous).toBe(1); // NORMAL = 1

    const foreignKeys = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(foreignKeys.foreign_keys).toBe(1);

    db.close();
  });

  it("creates the database file if it does not exist", () => {
    expect(existsSync(TEST_DB)).toBe(false);
    const db = createDb(TEST_DB);
    expect(existsSync(TEST_DB)).toBe(true);
    db.close();
  });
});

import { withRetrySync } from "../src/db";

describe("withRetrySync", () => {
  it("returns the result on success", () => {
    const result = withRetrySync(() => 42);
    expect(result).toBe(42);
  });

  it("retries on SQLITE_BUSY and eventually succeeds", () => {
    let attempts = 0;
    const result = withRetrySync(() => {
      attempts++;
      if (attempts < 3) {
        throw new Error("database is locked");
      }
      return "success";
    });
    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });

  it("throws after max retries exhausted", () => {
    expect(() =>
      withRetrySync(() => {
        throw new Error("database is locked");
      }, 2)
    ).toThrow("database is locked");
  });

  it("throws immediately for non-BUSY errors", () => {
    expect(() =>
      withRetrySync(() => {
        throw new Error("syntax error");
      })
    ).toThrow("syntax error");
  });
});
