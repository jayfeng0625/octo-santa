import { describe, it, expect, afterEach } from "bun:test";
import { allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { MessagingService } from "../../src/core/messaging/service";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";

const TEST_DB = testDbPath("channels");

function setup() {
  const db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid);
  svc.register("octo-santa");
  return { db, svc };
}

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("createChannel", () => {
  it("creates a new channel", () => {
    const { db, svc } = setup();
    const channel = svc.createChannel("octo-santa", "coordination");

    expect(channel.name).toBe("coordination");
    expect(channel.created_by).toBe("octo-santa");
    expect(channel.id).toBeGreaterThan(0);

    db.close();
  });

  it("is idempotent — returns existing channel on duplicate name", () => {
    const { db, svc } = setup();
    const first = svc.createChannel("octo-santa", "coordination");
    const second = svc.createChannel("octo-santa", "coordination");

    expect(second.id).toBe(first.id);
    expect(second.name).toBe(first.name);

    db.close();
  });

  it("throws when creating before registering", () => {
    const { db, svc } = setup();

    expect(() => svc.createChannel("unregistered-agent", "frontend")).toThrow(
      `Agent "unregistered-agent" must call messaging_register before using messaging tools`
    );
    db.close();
  });

  it("does not auto-subscribe the creator (no cursor created)", () => {
    const { db, svc } = setup();
    svc.createChannel("octo-santa", "no-cursor-ch");

    const channel = db.query("SELECT id FROM channels WHERE name = ?").get("no-cursor-ch") as { id: number };
    const cursor = db.query(
      "SELECT * FROM cursors WHERE agent_id = ? AND channel_id = ?"
    ).get("octo-santa", channel.id);
    expect(cursor).toBeNull();

    db.close();
  });
});

describe("listChannels", () => {
  it("returns empty list when no channels exist", () => {
    const { db, svc } = setup();
    expect(svc.listChannels()).toEqual([]);
    db.close();
  });

  it("returns all channels", () => {
    const { db, svc } = setup();
    svc.createChannel("octo-santa", "frontend");
    svc.createChannel("octo-santa", "backend");

    const channels = svc.listChannels();
    expect(channels).toHaveLength(2);
    expect(channels.map((c) => c.name).sort()).toEqual(["backend", "frontend"]);

    db.close();
  });
});
