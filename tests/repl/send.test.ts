import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { createDb } from "../../src/db";
import { runMigrations } from "../../src/migrations";
import { messagingMigrations, readMessages } from "../../src/modules/messaging/tools";
import { runSendMode } from "../../src/repl/send";

const TEST_DB = "/tmp/octo-santa-test-repl-send.sqlite";
const TEST_FILE = "/tmp/octo-santa-test-brief.md";

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
  if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);
});

describe("runSendMode", () => {
  it("sends file contents as a message", () => {
    const db = setupDb();
    writeFileSync(TEST_FILE, "# Task Brief\n\nDo the thing.");

    const result = runSendMode(db, "jay", "planning", TEST_FILE);

    expect(result.agent_id).toBe("jay");
    expect(result.content).toBe("# Task Brief\n\nDo the thing.");
    db.close();
  });

  it("message is readable by other agents", () => {
    const db = setupDb();
    writeFileSync(TEST_FILE, "hello from human");

    runSendMode(db, "jay", "planning", TEST_FILE);

    const messages = readMessages(db, "agent-a", "planning");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("hello from human");
    expect(messages[0]!.agent_id).toBe("jay");
    db.close();
  });
});
