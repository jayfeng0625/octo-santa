import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { createDb } from "../../src/db";
import { runMigrations } from "../../src/migrations";
import {
  messagingMigrations,
  registerAgent,
  listAgents,
} from "../../src/modules/messaging/tools";

const TEST_DB = "/tmp/octo-santa-test-agents.sqlite";

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = path + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
}

function setupDb() {
  cleanupDb(TEST_DB);
  const db = createDb(TEST_DB);
  runMigrations(db, messagingMigrations);
  return db;
}

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("listAgents", () => {
  it("returns empty list when no agents", () => {
    const db = setupDb();
    expect(listAgents(db)).toEqual([]);
    db.close();
  });

  it("returns all registered agents", () => {
    const db = setupDb();
    registerAgent(db, "octo-santa");
    registerAgent(db, "payment-service");

    const agents = listAgents(db);
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.id).sort()).toEqual(["octo-santa", "payment-service"]);

    db.close();
  });
});
