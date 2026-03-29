// tests/repl/app.test.tsx

import { describe, it, expect, afterEach } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { existsSync, unlinkSync } from "node:fs";
import { createDb } from "../../src/db";
import { runMigrations } from "../../src/migrations";
import { messagingMigrations, sendMessage } from "../../src/modules/messaging/tools";
import { App } from "../../src/repl/app";

const TEST_DB = "/tmp/octo-santa-test-app.sqlite";

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

describe("App", () => {
  afterEach(() => cleanupDb(TEST_DB));

  it("renders welcome message and prompt", () => {
    const db = setupDb();
    const { lastFrame } = render(
      <App db={db} agentId="human" initialChannel="general" />
    );
    const frame = lastFrame()!;
    expect(frame).toContain("general");
    db.close();
  });

  it("shows messages from other agents after poll", async () => {
    const db = setupDb();

    const { lastFrame } = render(
      <App db={db} agentId="human" initialChannel="general" pollIntervalMs={50} />
    );

    // Send AFTER render so the message ID is above the App's initial cursor
    sendMessage(db, "bot", "general", "hello from bot");

    // Wait for poll to pick up the message
    await new Promise((r) => setTimeout(r, 200));
    const frame = lastFrame()!;
    expect(frame).toContain("hello from bot");
    db.close();
  });
});
