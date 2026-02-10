// tests/integration.test.ts
import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { createDb } from "../src/db";
import { runMigrations } from "../src/migrations";
import {
  messagingMigrations,
  registerAgent,
  createChannel,
  listChannels,
  sendMessage,
  readMessages,
  listAgents,
} from "../src/modules/messaging/tools";

const TEST_DB = "/tmp/octo-santa-test-integration.sqlite";

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

describe("full messaging flow", () => {
  it("two agents communicate through a channel", () => {
    const db = setupDb();

    // Agent A sets up and sends
    registerAgent(db, "frontend-app");
    createChannel(db, "coordination", "frontend-app");
    sendMessage(db, "frontend-app", "coordination", "Need API endpoint for /users");
    sendMessage(db, "frontend-app", "coordination", "Expecting JSON with name and email fields");

    // Agent B reads and replies
    const incoming = readMessages(db, "backend-api", "coordination");
    expect(incoming).toHaveLength(2);
    expect(incoming[0]!.content).toBe("Need API endpoint for /users");
    expect(incoming[0]!.agent_id).toBe("frontend-app");

    sendMessage(db, "backend-api", "coordination", "Done. GET /users returns {name, email}");

    // Agent A reads the reply
    const reply = readMessages(db, "frontend-app", "coordination");
    expect(reply).toHaveLength(1);
    expect(reply[0]!.content).toBe("Done. GET /users returns {name, email}");
    expect(reply[0]!.agent_id).toBe("backend-api");

    // Both agents visible
    const agents = listAgents(db);
    expect(agents).toHaveLength(2);

    // Channel visible
    const channels = listChannels(db);
    expect(channels).toHaveLength(1);
    expect(channels[0]!.name).toBe("coordination");

    db.close();
  });

  it("agents can use multiple channels independently", () => {
    const db = setupDb();

    sendMessage(db, "agent-a", "frontend", "UI question");
    sendMessage(db, "agent-a", "backend", "API question");

    const frontend = readMessages(db, "agent-b", "frontend");
    const backend = readMessages(db, "agent-b", "backend");

    expect(frontend).toHaveLength(1);
    expect(frontend[0]!.content).toBe("UI question");

    expect(backend).toHaveLength(1);
    expect(backend[0]!.content).toBe("API question");

    db.close();
  });
});
