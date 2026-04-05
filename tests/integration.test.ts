// tests/integration.test.ts
import { describe, it, expect, afterEach } from "bun:test";
import { cleanupDb, testDbPath, setupTestDb } from "./helpers/db";
import { allMigrations } from "../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../src/storage/sqlite";
import { MessagingService } from "../src/core/messaging/service";

const TEST_DB = testDbPath("integration");

function setup() {
  const db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid);
  return { db, svc };
}

afterEach(() => {
  cleanupDb(TEST_DB);
});

describe("full messaging flow", () => {
  it("two agents communicate through a channel", () => {
    const { db, svc } = setup();

    // Agent A and B both join the channel first
    svc.register("frontend-app");
    svc.register("backend-api");
    svc.createChannel("frontend-app", "coordination");
    svc.subscribe("backend-api", "coordination");

    // Agent A sends
    svc.send("frontend-app", "coordination", "Need API endpoint for /users");
    svc.send("frontend-app", "coordination", "Expecting JSON with name and email fields");

    // Agent B reads
    const incoming = svc.read("backend-api", "coordination");
    expect(incoming).toHaveLength(2);
    expect(incoming[0]!.content).toBe("Need API endpoint for /users");
    expect(incoming[0]!.agent_id).toBe("frontend-app");

    svc.send("backend-api", "coordination", "Done. GET /users returns {name, email}");

    // Agent A reads the reply
    const reply = svc.read("frontend-app", "coordination");
    expect(reply).toHaveLength(1);
    expect(reply[0]!.content).toBe("Done. GET /users returns {name, email}");
    expect(reply[0]!.agent_id).toBe("backend-api");

    // Both agents visible
    const agents = svc.listAgents();
    expect(agents).toHaveLength(2);

    // Channel visible
    const channels = svc.listChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0]!.name).toBe("coordination");

    db.close();
  });

  it("agents can use multiple channels independently", () => {
    const { db, svc } = setup();

    // agent-b subscribes before messages are sent so cursor starts at 0
    svc.register("agent-a");
    svc.register("agent-b");
    svc.createChannel("agent-b", "frontend");
    svc.createChannel("agent-b", "backend");
    svc.subscribe("agent-b", "frontend");
    svc.subscribe("agent-b", "backend");

    svc.send("agent-a", "frontend", "UI question");
    svc.send("agent-a", "backend", "API question");

    const frontend = svc.read("agent-b", "frontend");
    const backend = svc.read("agent-b", "backend");

    expect(frontend).toHaveLength(1);
    expect(frontend[0]!.content).toBe("UI question");

    expect(backend).toHaveLength(1);
    expect(backend[0]!.content).toBe("API question");

    db.close();
  });
});
