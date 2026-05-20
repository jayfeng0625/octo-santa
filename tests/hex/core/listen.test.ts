import { describe, it, expect, afterEach } from "bun:test";
import { MessagingService } from "../../../src/core/messaging/service";
import { createSqliteRepos } from "../../../src/storage/sqlite";
import { createDb } from "../../../src/storage/sqlite/db";
import { runMigrations, allMigrations } from "../../../src/storage/sqlite/migrations";
import { createNotificationDispatcher } from "../../../src/notifications/dispatch/dispatcher";
import { cleanupDb } from "../../helpers/db";

const TEST_DB = `/tmp/octo-santa-test-hex-listen-${process.pid}.sqlite`;

function setup() {
  cleanupDb(TEST_DB);
  const db = createDb(TEST_DB);
  runMigrations(db, allMigrations);
  const repos = createSqliteRepos(db);
  const dispatcher = createNotificationDispatcher();
  const svc = new MessagingService(
    repos.agents,
    repos.channels,
    repos.messages,
    repos.cursors,
    process.pid,
    dispatcher
  );
  return { db, repos, svc };
}

afterEach(() => cleanupDb(TEST_DB));

describe("readAllUnread()", () => {
  it("returns empty array when agent has no subscriptions", () => {
    const { svc } = setup();
    svc.register("alice");

    const result = svc.readAllUnread("alice");
    expect(result).toEqual([]);
  });

  it("returns only channels with unread messages, skips empty ones", () => {
    const { svc } = setup();
    svc.register("alice");
    svc.register("bob");

    svc.createChannel("alice", "active");
    svc.subscribe("alice", "active");
    svc.subscribe("bob", "active");

    svc.createChannel("alice", "quiet");
    svc.subscribe("alice", "quiet");

    svc.send("bob", "active", "hello alice");

    const result = svc.readAllUnread("alice");
    expect(result.length).toBe(1);
    expect(result[0]!.channel).toBe("active");
    expect(result[0]!.messages.length).toBe(1);
    expect(result[0]!.messages[0]!.content).toBe("hello alice");
  });

  it("advances cursors so second call returns empty", () => {
    const { svc } = setup();
    svc.register("alice");
    svc.register("bob");

    svc.createChannel("alice", "general");
    svc.subscribe("alice", "general");
    svc.subscribe("bob", "general");

    svc.send("bob", "general", "first message");

    const first = svc.readAllUnread("alice");
    expect(first.length).toBe(1);
    expect(first[0]!.messages.length).toBe(1);

    const second = svc.readAllUnread("alice");
    expect(second).toEqual([]);
  });

  it("marks DM channels with is_dm: true", () => {
    const { svc } = setup();
    svc.register("alice");
    svc.register("bob");

    svc.directMessage("bob", "alice", "hey alice");

    const result = svc.readAllUnread("alice");
    expect(result.length).toBe(1);
    expect(result[0]!.channel).toBe("alice,bob");
    expect(result[0]!.is_dm).toBe(true);
    expect(result[0]!.messages.length).toBe(1);
    expect(result[0]!.messages[0]!.content).toBe("hey alice");
  });

  it("marks regular channels with is_dm: false", () => {
    const { svc } = setup();
    svc.register("alice");
    svc.register("bob");

    svc.createChannel("alice", "general");
    svc.subscribe("alice", "general");
    svc.subscribe("bob", "general");

    svc.send("bob", "general", "hello");

    const result = svc.readAllUnread("alice");
    expect(result.length).toBe(1);
    expect(result[0]!.is_dm).toBe(false);
  });

  it("throws if agent is not registered", () => {
    const { svc } = setup();

    expect(() => svc.readAllUnread("ghost")).toThrow(
      'Agent "ghost" must call messaging_register before using messaging tools'
    );
  });
});
