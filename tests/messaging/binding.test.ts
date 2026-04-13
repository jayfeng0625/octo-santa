import { describe, it, expect, afterEach } from "bun:test";
import { cleanupDb, testDbPath, setupTestDb } from "../helpers/db";
import { allMigrations } from "../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../src/storage/sqlite";
import { MessagingService } from "../../src/core/messaging/service";
import { registerMessagingTools } from "../../src/transports/mcp-stdio/adapter";
import type { ProfileRepository } from "../../src/core/ports";
import type { AgentProfile } from "../../src/core/profiles/types";

const TEST_DB = testDbPath("binding");

afterEach(() => {
  cleanupDb(TEST_DB);
});

// ── In-memory ProfileRepository for tests ────────────────────────────────────

class InMemoryProfileRepo implements ProfileRepository {
  private profiles = new Map<string, AgentProfile>();

  add(profile: AgentProfile): void {
    this.profiles.set(profile.name, profile);
  }

  getProfile(baseName: string): AgentProfile | null {
    return this.profiles.get(baseName) ?? null;
  }

  listProfiles(): AgentProfile[] {
    return [...this.profiles.values()];
  }

  getBaseNames(): Set<string> {
    return new Set(this.profiles.keys());
  }
}

function setup(profileRepo?: ProfileRepository) {
  const db = setupTestDb(TEST_DB, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid, undefined, profileRepo);

  const handlers: Record<string, (...args: any[]) => Promise<any>> = {};
  const mockServer = {
    registerTool: (name: string, _config: unknown, cb: (...args: any[]) => Promise<any>) => {
      handlers[name] = cb;
    },
  } as any;

  let bound: string | null = null;
  function onAgentId(agentId: string): { commit: (resolvedName?: string) => void } {
    if (bound !== null && bound !== agentId) {
      throw new Error(`Session already bound to agent "${bound}", cannot use "${agentId}"`);
    }
    return {
      commit: (resolvedName?: string) => { bound = resolvedName ?? agentId; },
    };
  }

  registerMessagingTools(mockServer, svc, onAgentId);
  return { db, handlers };
}

describe("agent binding enforcement", () => {
  it("rejects mismatched agent_id on send WITHOUT persisting the message", async () => {
    const { db, handlers } = setup();
    await handlers.messaging_register!({ agent_id: "agent-a" });

    let threw = false;
    try {
      await handlers.messaging_send_message!({
        agent_id: "agent-b",
        channel: "coordination",
        content: "should not persist",
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    const rows = db.query("SELECT * FROM messages").all();
    expect(rows.length).toBe(0);
    db.close();
  });

  it("rejects mismatched agent_id on read WITHOUT creating a cursor", async () => {
    const { db, handlers } = setup();
    await handlers.messaging_register!({ agent_id: "agent-a" });

    let threw = false;
    try {
      await handlers.messaging_read_messages!({
        agent_id: "agent-b",
        channel: "coordination",
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    const cursors = db.query("SELECT * FROM cursors").all();
    expect(cursors.length).toBe(0);
    db.close();
  });

  it("does NOT bind session when registration fails (invalid name)", async () => {
    const { db, handlers } = setup();

    let threw = false;
    try {
      await handlers.messaging_register!({ agent_id: "bad name" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Should be able to register with a valid name (session not stuck)
    const result = await handlers.messaging_register!({ agent_id: "good-name" });
    expect(result.content[0].text).toContain("good-name");
    db.close();
  });

  it("does NOT bind session when registration fails (duplicate name from another process)", async () => {
    const { db, handlers } = setup();

    // Simulate another process already owning "taken" (PID 1 = init, always alive)
    const now = Date.now();
    db.run(
      "INSERT INTO agents (id, created_at, last_seen_at, pid, registered_at) VALUES (?, ?, ?, ?, ?)",
      ["taken", now, now, 1, now]
    );

    // First registration attempt should fail (PID 1 is alive)
    let threw = false;
    try {
      await handlers.messaging_register!({ agent_id: "taken" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Should be able to register with a different name (session not stuck)
    const result = await handlers.messaging_register!({ agent_id: "other-name" });
    expect(result.content[0].text).toContain("other-name");
    db.close();
  });

  it("allows same agent_id on subsequent calls", async () => {
    const { db, handlers } = setup();
    await handlers.messaging_register!({ agent_id: "agent-a" });
    await handlers.messaging_create_channel!({ agent_id: "agent-a", name: "coordination" });

    const result = await handlers.messaging_send_message!({
      agent_id: "agent-a",
      channel: "coordination",
      content: "hello",
    });

    expect(result.content[0].text).toContain("hello");
    db.close();
  });

  it("messaging_list_members returns members with active flag and correct data", async () => {
    const { db, handlers } = setup();
    await handlers.messaging_register!({ agent_id: "agent-a" });
    await handlers.messaging_create_channel!({ agent_id: "agent-a", name: "ch" });
    await handlers.messaging_send_message!({ agent_id: "agent-a", channel: "ch", content: "hi" });

    const result = await handlers.messaging_list_members!({ channel: "ch" });
    const members = JSON.parse(result.content[0].text);
    expect(members).toHaveLength(1);
    expect(members[0].agent_id).toBe("agent-a");
    expect(members[0].active).toBe(true);
    db.close();
  });

  it("messaging_list_agents include_stale filters correctly", async () => {
    const { db, handlers } = setup();
    await handlers.messaging_register!({ agent_id: "agent-a" });
    // Seed a no-PID agent directly in the DB (simulates stale agent)
    db.run("INSERT INTO agents (id, created_at, last_seen_at) VALUES (?, ?, ?)", ["no-pid-agent", Date.now(), Date.now()]);

    const allResult = await handlers.messaging_list_agents!({ include_stale: true });
    const allAgents = JSON.parse(allResult.content[0].text);
    expect(allAgents.length).toBeGreaterThanOrEqual(2); // agent-a + no-pid-agent

    const activeResult = await handlers.messaging_list_agents!({ include_stale: false });
    const activeAgents = JSON.parse(activeResult.content[0].text);
    expect(activeAgents).toHaveLength(1);
    expect(activeAgents[0].id).toBe("agent-a");
    db.close();
  });

  it("messaging_list_agents with no args returns active agents only (default)", async () => {
    const { db, handlers } = setup();
    await handlers.messaging_register!({ agent_id: "agent-a" });
    // Seed a stale no-PID agent
    db.run("INSERT INTO agents (id, created_at, last_seen_at) VALUES (?, ?, ?)", ["stale-agent", Date.now(), Date.now()]);

    const result = await handlers.messaging_list_agents!({});
    const agents = JSON.parse(result.content[0].text);
    expect(agents.length).toBe(1);
    expect(agents[0].id).toBe("agent-a");
    db.close();
  });
});

describe("profile-based name resolution in transport binding", () => {
  it("register base name with pool profile → bound to resolvedName (os-dev-1)", async () => {
    const profileRepo = new InMemoryProfileRepo();
    profileRepo.add({
      name: "os-dev",
      persona: "Senior developer",
      objective: "Write clean code",
      instructions: null,
      maxInstances: 3,
      autoJoinChannels: [],
    });

    const { db, handlers } = setup(profileRepo);
    const raw = await handlers.messaging_register!({ agent_id: "os-dev" });
    const result = JSON.parse(raw.content[0].text);

    expect(result.registeredName).toBe("os-dev-1");
    expect(result.baseName).toBe("os-dev");
    expect(result.instanceNumber).toBe(1);

    db.close();
  });

  it("subsequent call with base name rejected after binding to pool slot", async () => {
    const profileRepo = new InMemoryProfileRepo();
    profileRepo.add({
      name: "os-dev",
      persona: null,
      objective: null,
      instructions: null,
      maxInstances: 3,
      autoJoinChannels: [],
    });

    const { db, handlers } = setup(profileRepo);
    await handlers.messaging_register!({ agent_id: "os-dev" });

    // After binding to "os-dev-1", calling with base name "os-dev" should be rejected
    let threw = false;
    try {
      await handlers.messaging_register!({ agent_id: "os-dev" });
    } catch (err) {
      threw = true;
      expect(String(err)).toContain("os-dev-1");
    }
    expect(threw).toBe(true);

    db.close();
  });
});
