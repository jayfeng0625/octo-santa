import { describe, it, expect, afterEach } from "bun:test";
import {
  messagingMigrations,
  registerAgent,
  createChannel,
  listChannels,
} from "../../src/modules/messaging/tools";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";

const TEST_DB = testDbPath("channels");

function setupDb() {
  const db = setupTestDb(TEST_DB, messagingMigrations);
  registerAgent(db, "octo-santa");
  return db;
}

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("createChannel", () => {
  it("creates a new channel", () => {
    const db = setupDb();
    const channel = createChannel(db, "coordination", "octo-santa");

    expect(channel.name).toBe("coordination");
    expect(channel.created_by).toBe("octo-santa");
    expect(channel.id).toBeGreaterThan(0);

    db.close();
  });

  it("is idempotent — returns existing channel on duplicate name", () => {
    const db = setupDb();
    const first = createChannel(db, "coordination", "octo-santa");
    const second = createChannel(db, "coordination", "octo-santa");

    expect(second.id).toBe(first.id);
    expect(second.name).toBe(first.name);

    db.close();
  });

  it("throws when creating before registering", () => {
    const db = setupDb();

    expect(() => createChannel(db, "frontend", "unregistered-agent")).toThrow(
      `Agent "unregistered-agent" must call messaging_register before using messaging tools`
    );
    db.close();
  });

  it("does not auto-subscribe the creator (no cursor created)", () => {
    const db = setupDb();
    createChannel(db, "no-cursor-ch", "octo-santa");

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
    const db = setupDb();
    expect(listChannels(db)).toEqual([]);
    db.close();
  });

  it("returns all channels", () => {
    const db = setupDb();
    createChannel(db, "frontend", "octo-santa");
    createChannel(db, "backend", "octo-santa");

    const channels = listChannels(db);
    expect(channels).toHaveLength(2);
    expect(channels.map((c) => c.name).sort()).toEqual(["backend", "frontend"]);

    db.close();
  });
});
