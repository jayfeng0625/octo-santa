// tests/hex/core/profile-integration.test.ts
//
// Full lifecycle integration test: real YAML profiles on disk + real SQLite.
// Exercises: register singleton/pool → auto-join → @base-name mention → read →
// list_agents with persona/objective → agent without profile has null fields.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "../../../src/storage/sqlite/db";
import { runMigrations, allMigrations } from "../../../src/storage/sqlite/migrations";
import { createSqliteRepos } from "../../../src/storage/sqlite";
import { MessagingService } from "../../../src/core/messaging/service";
import { YamlProfileStore } from "../../../src/storage/yaml-profiles/store";

// ── Captured dispatch helper ───────────────────────────────────────────────

type DispatchCall = {
  channelName: string;
  sender: string;
  content: string;
  messageId: number;
  isDm: boolean;
  targetAgents: string[];
};

function makeCapturingDispatch() {
  const dispatched: DispatchCall[] = [];
  return {
    dispatched,
    dispatch(notification: DispatchCall) {
      dispatched.push({ ...notification });
    },
  };
}

// ── Test fixture ──────────────────────────────────────────────────────────

describe("Profile Integration — Full Lifecycle", () => {
  let profileDir: string;
  let dbPath: string;

  beforeEach(() => {
    profileDir = mkdtempSync(join(tmpdir(), "profiles-integration-"));
    dbPath = join(tmpdir(), `octo-santa-integration-${Date.now()}-${process.pid}.db`);
  });

  afterEach(() => {
    rmSync(profileDir, { recursive: true, force: true });
    for (const ext of ["", "-wal", "-shm"]) {
      const f = dbPath + ext;
      if (existsSync(f)) unlinkSync(f);
    }
  });

  it("full lifecycle: profiles → register → auto-join → mention → read → list", () => {
    // ── Step 1: Write profile YAML files ────────────────────────────────

    writeFileSync(
      join(profileDir, "os-pm.yaml"),
      [
        "name: os-pm",
        'persona: "Product manager"',
        'objective: "Drive roadmap"',
        "maxInstances: 1",
        "autoJoinChannels:",
        "  - coordination",
        'instructions: "When you receive a proposal, evaluate against priorities and provide a clear decision."',
      ].join("\n")
    );

    writeFileSync(
      join(profileDir, "os-dev.yaml"),
      [
        "name: os-dev",
        'persona: "Developer"',
        'objective: "Ship code"',
        "maxInstances: 3",
        "autoJoinChannels:",
        "  - coordination",
      ].join("\n")
    );

    // ── Step 2: Wire up real storage + profile store ─────────────────────

    const profiles = new YamlProfileStore(profileDir);
    const db = createDb(dbPath);
    runMigrations(db, allMigrations);
    const repos = createSqliteRepos(db);

    // ── Step 3: Create coordination channel before registration ──────────
    // Use an admin MessagingService (no profiles) to create the channel so
    // auto-join can find it.

    const adminSvc = new MessagingService(
      repos.agents,
      repos.channels,
      repos.messages,
      repos.cursors,
      process.pid
    );
    adminSvc.register("admin");
    adminSvc.createChannel("admin", "coordination");

    // ── Step 4: Create profile-aware service with capturing dispatch ──────

    const capturing = makeCapturingDispatch();
    const svc = new MessagingService(
      repos.agents,
      repos.channels,
      repos.messages,
      repos.cursors,
      process.pid,
      capturing,
      profiles
    );

    // ── Step 5a: Register singleton (os-pm, maxInstances=1) ──────────────

    const pmResult = svc.register("os-pm");

    expect(pmResult.registeredName).toBe("os-pm");
    expect(pmResult.baseName).toBe("os-pm");
    expect(pmResult.instanceNumber).toBeNull(); // singleton → null
    expect(pmResult.profile).not.toBeNull();
    expect(pmResult.profile!.persona).toBe("Product manager");
    expect(pmResult.autoJoined).not.toBeNull();
    expect(pmResult.autoJoined!.succeeded).toContain("coordination");
    expect(pmResult.autoJoined!.failed).toEqual([]);
    expect(pmResult.profile!.instructions).toBe(
      "When you receive a proposal, evaluate against priorities and provide a clear decision."
    );

    // ── Step 5b: Register pool agent (os-dev, maxInstances=3) ─────────────

    const devResult = svc.register("os-dev");

    expect(devResult.registeredName).toBe("os-dev-1");
    expect(devResult.baseName).toBe("os-dev");
    expect(devResult.instanceNumber).toBe(1);
    expect(devResult.profile).not.toBeNull();
    expect(devResult.profile!.maxInstances).toBe(3);
    expect(devResult.autoJoined).not.toBeNull();
    expect(devResult.autoJoined!.succeeded).toContain("coordination");
    expect(devResult.autoJoined!.failed).toEqual([]);

    // ── Step 6: Send with @base-name ──────────────────────────────────────
    // os-pm sends "@os-dev" — should expand to os-dev-1 in dispatch

    const msg = svc.send("os-pm", "coordination", "Hey @os-dev, review this");
    expect(msg.agent_id).toBe("os-pm");

    // The stored mentions should contain the raw base name "os-dev"
    const msgRow = db
      .query("SELECT mentions FROM messages WHERE id = ?")
      .get(msg.id) as { mentions: string } | null;
    expect(msgRow).not.toBeNull();
    const storedMentions = JSON.parse(msgRow!.mentions) as string[];
    expect(storedMentions).toContain("os-dev");

    // Dispatch targets should include "os-dev-1" (expanded from base name)
    expect(capturing.dispatched.length).toBeGreaterThanOrEqual(1);
    const dispatchCall = capturing.dispatched.find(
      (d) => d.messageId === msg.id
    );
    expect(dispatchCall).toBeDefined();
    expect(dispatchCall!.targetAgents).toContain("os-dev-1");

    // ── Step 7: Read messages ─────────────────────────────────────────────

    const messages = svc.read("os-dev-1", "coordination");
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const found = messages.find((m) => m.id === msg.id);
    expect(found).toBeDefined();
    expect(found!.content).toBe("Hey @os-dev, review this");

    // ── Step 8: listAgents with persona/objective ─────────────────────────

    const agents = svc.listAgents(true); // include stale to see all

    const pmAgent = agents.find((a) => a.id === "os-pm");
    expect(pmAgent).toBeDefined();
    expect(pmAgent!.persona).toBe("Product manager");
    expect(pmAgent!.objective).toBe("Drive roadmap");
    expect(pmAgent!.instructions).toBe(
      "When you receive a proposal, evaluate against priorities and provide a clear decision."
    );

    // Verify DB persistence directly via raw SQL
    const row = db.query("SELECT instructions FROM agents WHERE id = ?").get("os-pm") as { instructions: string } | null;
    expect(row).not.toBeNull();
    expect(row!.instructions).toBe(
      "When you receive a proposal, evaluate against priorities and provide a clear decision."
    );

    const devAgent = agents.find((a) => a.id === "os-dev-1");
    expect(devAgent).toBeDefined();
    expect(devAgent!.persona).toBe("Developer");
    expect(devAgent!.objective).toBe("Ship code");

    // ── Step 9: Agent without profile has null fields ─────────────────────

    const botResult = svc.register("random-bot");
    expect(botResult.registeredName).toBe("random-bot");
    expect(botResult.baseName).toBeNull();
    expect(botResult.profile).toBeNull();
    expect(botResult.autoJoined).toBeNull();

    const botAgent = svc.listAgents(true).find((a) => a.id === "random-bot");
    expect(botAgent).toBeDefined();
    expect(botAgent!.persona).toBeNull();
    expect(botAgent!.objective).toBeNull();
    expect(botAgent!.base_name).toBeNull();
    expect(botAgent!.instructions).toBeNull();

    db.close();
  });

  it("getInstructions returns profile instructions for registered agent", () => {
    writeFileSync(
      join(profileDir, "os-pm.yaml"),
      [
        "name: os-pm",
        'persona: "Product manager"',
        'objective: "Drive roadmap"',
        'instructions: "Evaluate proposals against priorities."',
      ].join("\n")
    );

    const profiles = new YamlProfileStore(profileDir);
    const db = createDb(dbPath);
    runMigrations(db, allMigrations);
    const repos = createSqliteRepos(db);
    const svc = new MessagingService(
      repos.agents, repos.channels, repos.messages, repos.cursors,
      process.pid, undefined, profiles
    );

    svc.register("os-pm");
    const result = svc.getInstructions("os-pm");
    expect(result.profile).not.toBeNull();
    expect(result.profile!.instructions).toBe("Evaluate proposals against priorities.");
    expect(result.profile!.persona).toBe("Product manager");

    db.close();
  });

  it("getInstructions returns null profile for agent without profile", () => {
    const db = createDb(dbPath);
    runMigrations(db, allMigrations);
    const repos = createSqliteRepos(db);
    const svc = new MessagingService(
      repos.agents, repos.channels, repos.messages, repos.cursors,
      process.pid
    );

    svc.register("random-bot");
    const result = svc.getInstructions("random-bot");
    expect(result.profile).toBeNull();

    db.close();
  });

  it("getInstructions throws for unregistered agent", () => {
    const db = createDb(dbPath);
    runMigrations(db, allMigrations);
    const repos = createSqliteRepos(db);
    const svc = new MessagingService(
      repos.agents, repos.channels, repos.messages, repos.cursors,
      process.pid
    );

    expect(() => svc.getInstructions("nobody")).toThrow(/messaging_register/);

    db.close();
  });

  it("getInstructions returns the agent's profile shape", () => {
    writeFileSync(
      join(profileDir, "os-pm.yaml"),
      [
        "name: os-pm",
        'persona: "Product manager"',
        'instructions: "Evaluate proposals."',
      ].join("\n")
    );

    const profiles = new YamlProfileStore(profileDir);
    const db = createDb(dbPath);
    runMigrations(db, allMigrations);
    const repos = createSqliteRepos(db);
    const svc = new MessagingService(
      repos.agents, repos.channels, repos.messages, repos.cursors,
      process.pid, undefined, profiles
    );

    svc.register("os-pm");
    const result = svc.getInstructions("os-pm");
    expect(result.profile).not.toBeNull();
    expect(result.profile!.instructions).toBe("Evaluate proposals.");

    db.close();
  });
});
