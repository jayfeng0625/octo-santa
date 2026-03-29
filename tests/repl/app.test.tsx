// tests/repl/app.test.tsx

import { describe, it, expect, afterEach } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { existsSync, unlinkSync } from "node:fs";
import { createDb } from "../../src/db";
import { runMigrations } from "../../src/migrations";
import { messagingMigrations, sendMessage, readMessages } from "../../src/modules/messaging/tools";
import { App } from "../../src/repl/app";

const tick = () => new Promise((r) => setTimeout(r, 10));
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
    const { lastFrame, unmount } = render(
      <App db={db} agentId="human" initialChannel="general" />
    );
    const frame = lastFrame()!;
    expect(frame).toContain("general");
    unmount();
    db.close();
  });

  it("shows messages from other agents after poll", async () => {
    const db = setupDb();

    const { lastFrame, unmount } = render(
      <App db={db} agentId="human" initialChannel="general" pollIntervalMs={50} />
    );

    // Send AFTER render so the message ID is above the App's initial cursor
    sendMessage(db, "bot", "general", "hello from bot");

    // Wait for poll to pick up the message
    await new Promise((r) => setTimeout(r, 200));
    const frame = lastFrame()!;
    expect(frame).toContain("hello from bot");
    unmount();
    db.close();
  });

  it("sends a message on Enter and displays it", async () => {
    const db = setupDb();
    const { lastFrame, stdin, unmount } = render(
      <App db={db} agentId="human" initialChannel="general" />
    );
    await tick();
    stdin.write("hello world");
    await tick();
    stdin.write("\r");
    await tick();
    const frame = lastFrame()!;
    expect(frame).toContain("[human] hello world");
    // Verify message was persisted to DB
    const msgs = readMessages(db, "bot", "general");
    expect(msgs.some((m) => m.content === "hello world")).toBe(true);
    unmount();
    db.close();
  });

  it("/help displays command list", async () => {
    const db = setupDb();
    const { lastFrame, stdin, unmount } = render(
      <App db={db} agentId="human" initialChannel="general" />
    );
    await tick();
    stdin.write("/help");
    await tick();
    stdin.write("\r");
    await tick();
    const frame = lastFrame()!;
    expect(frame).toContain("/channels");
    expect(frame).toContain("/quit");
    unmount();
    db.close();
  });

  it("/join switches channel and updates prompt", async () => {
    const db = setupDb();
    const { lastFrame, stdin, unmount } = render(
      <App db={db} agentId="human" initialChannel="general" />
    );
    await tick();
    stdin.write("/join ops");
    await tick();
    stdin.write("\r");
    await tick();
    const frame = lastFrame()!;
    expect(frame).toContain("Switched to #ops");
    expect(frame).toContain("ops>");
    unmount();
    db.close();
  });

  it("multiline input starting with / is sent as message, not parsed as command", async () => {
    const db = setupDb();
    const { lastFrame, stdin, unmount } = render(
      <App db={db} agentId="human" initialChannel="general" />
    );
    await tick();
    stdin.write("/not-a-command");
    await tick();
    stdin.write("\x1b[13;2u"); // Shift+Enter — newline
    await tick();
    stdin.write("second line");
    await tick();
    stdin.write("\r");
    await tick();
    const frame = lastFrame()!;
    // Should be displayed as a message, not "Unknown command"
    expect(frame).toContain("[human]");
    expect(frame).not.toContain("Unknown command");
    // Verify persisted content includes both lines
    const msgs = readMessages(db, "bot", "general");
    expect(msgs.some((m) => m.content.includes("/not-a-command") && m.content.includes("second line"))).toBe(true);
    unmount();
    db.close();
  });
});
