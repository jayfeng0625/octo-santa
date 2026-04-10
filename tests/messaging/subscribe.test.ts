import { describe, it, expect, afterEach } from "bun:test";
import { allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { MessagingService } from "../../src/core/messaging/service";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";

const TEST_DB = testDbPath("subscribe");

function setup() {
  const db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid);
  return { db, svc };
}

afterEach(() => cleanupDb(TEST_DB));

describe("subscribe", () => {
  it("creates cursor at 0 so new subscriber sees full history", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.createChannel("agent-a", "planning");
    svc.send("agent-a", "planning", "msg one");
    svc.send("agent-a", "planning", "msg two");
    svc.send("agent-a", "planning", "msg three");

    svc.register("jay");
    svc.subscribe("jay", "planning");

    // Cursor starts at 0, so first read returns all pre-existing messages
    const unread = svc.read("jay", "planning");
    expect(unread).toHaveLength(3);
    expect(unread[0]!.content).toBe("msg one");
    db.close();
  });

  it("preserves existing cursor (does not lose unread backlog)", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.createChannel("agent-a", "planning");
    svc.send("agent-a", "planning", "old msg");

    // jay subscribes and reads, setting cursor
    svc.register("jay");
    svc.subscribe("jay", "planning");
    svc.read("jay", "planning");

    // New messages arrive while jay is away
    svc.send("agent-a", "planning", "new msg 1");
    svc.send("agent-a", "planning", "new msg 2");

    // Reconnect: subscribe should NOT advance cursor
    svc.subscribe("jay", "planning");

    // Unread messages should still be available
    const unread = svc.read("jay", "planning");
    expect(unread).toHaveLength(2);
    expect(unread[0]!.content).toBe("new msg 1");
    db.close();
  });

  it("subscribe to non-existent channel throws error", () => {
    const { db, svc } = setup();
    svc.register("jay");

    expect(() => svc.subscribe("jay", "no-such-channel")).toThrow(
      `Channel "no-such-channel" does not exist`
    );
    db.close();
  });

  it("double-subscribe is idempotent (no error, cursor preserved)", () => {
    const { db, svc } = setup();
    svc.register("jay");
    svc.register("agent-a");
    svc.createChannel("jay", "my-channel");

    svc.subscribe("jay", "my-channel");
    svc.send("agent-a", "my-channel", "message after first subscribe");

    // Second subscribe should not throw and should not advance cursor
    expect(() => svc.subscribe("jay", "my-channel")).not.toThrow();

    // Cursor still sees the unread message
    const unread = svc.read("jay", "my-channel");
    expect(unread).toHaveLength(1);
    expect(unread[0]!.content).toBe("message after first subscribe");
    db.close();
  });

  it("subscribe before register throws error", () => {
    const { db, svc } = setup();
    svc.register("agent-a");
    svc.createChannel("agent-a", "planning");
    svc.send("agent-a", "planning", "msg");
    // jay is NOT registered

    expect(() => svc.subscribe("jay", "planning")).toThrow(
      `Agent "jay" must call messaging_register before using messaging tools`
    );
    db.close();
  });
});
