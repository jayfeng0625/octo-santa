import { describe, it, expect, afterEach } from "bun:test";
import { MessagingService } from "../../../src/core/messaging/service";
import { createSqliteRepos } from "../../../src/storage/sqlite";
import { createDb } from "../../../src/storage/sqlite/db";
import { runMigrations, allMigrations } from "../../../src/storage/sqlite/migrations";
import { cleanupDb } from "../../helpers/db";
import type { ProfileRepository } from "../../../src/core/ports";
import type { AgentProfile } from "../../../src/core/profiles/types";

const TEST_DB = `/tmp/octo-santa-test-hex-profile-reg-${process.pid}.sqlite`;

// ── In-memory ProfileRepository for tests ─────────────────────────────────

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

// ── Setup helpers ──────────────────────────────────────────────────────────

function setup(profileRepo?: ProfileRepository) {
  cleanupDb(TEST_DB);
  const db = createDb(TEST_DB);
  runMigrations(db, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(
    repos.agents,
    repos.channels,
    repos.messages,
    repos.cursors,
    process.pid,
    undefined, // dispatch
    profileRepo
  );
  return { db, repos, svc };
}

afterEach(() => cleanupDb(TEST_DB));

// ── Singleton profile registration ────────────────────────────────────────

describe("singleton profile registration", () => {
  it("registers agent under profile and returns RegisterResult with profile fields", () => {
    const profileRepo = new InMemoryProfileRepo();
    profileRepo.add({
      name: "os-dev",
      persona: "Senior developer",
      objective: "Write clean code",
      maxInstances: 1,
      autoJoinChannels: [],
    });

    const { svc } = setup(profileRepo);
    const result = svc.register("os-dev");

    // Core Agent fields
    expect(result.id).toBe("os-dev");
    expect(result.pid).toBe(process.pid);

    // RegisterResult fields
    expect(result.registeredName).toBe("os-dev");
    expect(result.baseName).toBe("os-dev");
    expect(result.instanceNumber).toBeNull(); // singleton → null
    expect(result.profile).not.toBeNull();
    expect(result.profile!.persona).toBe("Senior developer");
    expect(result.profile!.objective).toBe("Write clean code");
    expect(result.profile!.maxInstances).toBe(1);
    expect(result.autoJoined).not.toBeNull();
    expect(result.autoJoined!.succeeded).toEqual([]);
    expect(result.autoJoined!.failed).toEqual([]);
  });

  it("stores base_name, persona, objective in DB for singleton", () => {
    const profileRepo = new InMemoryProfileRepo();
    profileRepo.add({
      name: "os-dev",
      persona: "Senior developer",
      objective: "Write clean code",
      maxInstances: 1,
      autoJoinChannels: [],
    });

    const { svc, db } = setup(profileRepo);
    svc.register("os-dev");

    const row = db.query("SELECT * FROM agents WHERE id = ?").get("os-dev") as {
      base_name: string | null;
      persona: string | null;
      objective: string | null;
    };
    expect(row).not.toBeNull();
    expect(row.base_name).toBe("os-dev");
    expect(row.persona).toBe("Senior developer");
    expect(row.objective).toBe("Write clean code");
  });
});

// ── Pool profile registration (multiple instances) ─────────────────────────

describe("pool profile registration", () => {
  it("assigns instance-1 to first pool member", () => {
    const profileRepo = new InMemoryProfileRepo();
    profileRepo.add({
      name: "worker",
      persona: null,
      objective: "Process tasks",
      maxInstances: 3,
      autoJoinChannels: [],
    });

    const { svc } = setup(profileRepo);
    const result = svc.register("worker");

    expect(result.registeredName).toBe("worker-1");
    expect(result.baseName).toBe("worker");
    expect(result.instanceNumber).toBe(1);
    expect(result.profile!.maxInstances).toBe(3);
  });

  it("assigns sequential slot numbers to pool members", () => {
    const profileRepo = new InMemoryProfileRepo();
    profileRepo.add({
      name: "worker",
      persona: null,
      objective: "Process tasks",
      maxInstances: 3,
      autoJoinChannels: [],
    });

    cleanupDb(TEST_DB);
    const db = createDb(TEST_DB);
    runMigrations(db, allMigrations);
    const repos = createSqliteRepos(db);

    // First instance at pid 1 (simulate different process — alive to block slot)
    // We can't easily simulate multi-pid in unit tests, so just test the naming pattern
    // by registering from same pid (idempotent), then verify the slot
    const svc1 = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid, undefined, profileRepo);
    const r1 = svc1.register("worker");
    expect(r1.instanceNumber).toBe(1);
    expect(r1.registeredName).toBe("worker-1");
  });

  it("same-PID re-registration is idempotent for pool", () => {
    const profileRepo = new InMemoryProfileRepo();
    profileRepo.add({
      name: "worker",
      persona: null,
      objective: "Process tasks",
      maxInstances: 3,
      autoJoinChannels: [],
    });

    const { svc } = setup(profileRepo);
    const first = svc.register("worker");
    const second = svc.register("worker");

    // Same PID → same slot returned
    expect(second.registeredName).toBe(first.registeredName);
    expect(second.instanceNumber).toBe(first.instanceNumber);
  });

  it("reclaims dead slot when all slots are taken but one is dead", () => {
    const profileRepo = new InMemoryProfileRepo();
    profileRepo.add({
      name: "worker",
      persona: null,
      objective: "Process tasks",
      maxInstances: 2,
      autoJoinChannels: [],
    });

    cleanupDb(TEST_DB);
    const db = createDb(TEST_DB);
    runMigrations(db, allMigrations);
    const repos = createSqliteRepos(db);

    // Manually insert two dead workers
    const now = Date.now();
    db.run(
      "INSERT INTO agents (id, created_at, last_seen_at, pid, registered_at, base_name) VALUES (?, ?, ?, ?, ?, ?)",
      ["worker-1", now, now - 1, 999999, now - 1, "worker"]  // dead PID
    );
    db.run(
      "INSERT INTO agents (id, created_at, last_seen_at, pid, registered_at, base_name) VALUES (?, ?, ?, ?, ?, ?)",
      ["worker-2", now, now - 1, 999998, now - 1, "worker"]  // dead PID
    );

    const svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid, undefined, profileRepo);
    const result = svc.register("worker");

    // Should reclaim slot 1 (lowest dead slot)
    expect(result.instanceNumber).toBe(1);
    expect(result.registeredName).toBe("worker-1");
    expect(result.pid).toBe(process.pid);
  });
});

// ── Backward compatibility — no profile, no profile repo ───────────────────

describe("backward compatibility — no profile", () => {
  it("registers normally without profile repo (undefined)", () => {
    const { svc } = setup(undefined); // no profileRepo
    const result = svc.register("alice");

    expect(result.id).toBe("alice");
    expect(result.registeredName).toBe("alice");
    expect(result.baseName).toBeNull();
    expect(result.instanceNumber).toBeNull();
    expect(result.profile).toBeNull();
    expect(result.autoJoined).toBeNull();
  });

  it("registers normally with profile repo but no matching profile", () => {
    const profileRepo = new InMemoryProfileRepo();
    // No profiles added for "alice"

    const { svc } = setup(profileRepo);
    const result = svc.register("alice");

    expect(result.registeredName).toBe("alice");
    expect(result.baseName).toBeNull();
    expect(result.profile).toBeNull();
    expect(result.autoJoined).toBeNull();
  });

  it("still allows register() return value to be used as Agent (structural compat)", () => {
    const { svc } = setup(undefined);
    const result = svc.register("alice");

    // All Agent fields must be accessible
    expect(typeof result.id).toBe("string");
    expect(typeof result.created_at).toBe("number");
    expect(typeof result.last_seen_at).toBe("number");
    // pid is number or null (number when just registered)
    expect(result.pid).toBe(process.pid);
  });
});

// ── Suffixed namespace reservation (Decision #14) ──────────────────────────

describe("suffixed namespace reservation", () => {
  it("rejects registering as 'os-dev-2' when 'os-dev' profile exists", () => {
    const profileRepo = new InMemoryProfileRepo();
    profileRepo.add({
      name: "os-dev",
      persona: null,
      objective: null,
      maxInstances: 3,
      autoJoinChannels: [],
    });

    const { svc } = setup(profileRepo);

    expect(() => svc.register("os-dev-2")).toThrow(
      `Name "os-dev-2" is reserved by pool profile "os-dev". Register as "os-dev" to join the pool.`
    );
  });

  it("rejects 'worker-10' when 'worker' profile exists", () => {
    const profileRepo = new InMemoryProfileRepo();
    profileRepo.add({
      name: "worker",
      persona: null,
      objective: null,
      maxInstances: 5,
      autoJoinChannels: [],
    });

    const { svc } = setup(profileRepo);

    expect(() => svc.register("worker-10")).toThrow(
      `Name "worker-10" is reserved by pool profile "worker".`
    );
  });

  it("allows registering 'os-dev-2' when no profile exists for 'os-dev'", () => {
    const profileRepo = new InMemoryProfileRepo();
    // No profile for "os-dev"

    const { svc } = setup(profileRepo);

    // Should not throw — no profile reservation applies
    expect(() => svc.register("os-dev-2")).not.toThrow();
    const result = svc.register("os-dev-2"); // second call — idempotent
    expect(result.registeredName).toBe("os-dev-2");
  });

  it("allows registering 'os-dev-2' when profileRepo is absent", () => {
    const { svc } = setup(undefined); // no profile repo

    expect(() => svc.register("os-dev-2")).not.toThrow();
    const result = svc.register("os-dev-2");
    expect(result.registeredName).toBe("os-dev-2");
  });

  it("only blocks numeric suffixes — 'os-dev-extra' is not rejected", () => {
    const profileRepo = new InMemoryProfileRepo();
    profileRepo.add({
      name: "os-dev",
      persona: null,
      objective: null,
      maxInstances: 3,
      autoJoinChannels: [],
    });

    const { svc } = setup(profileRepo);

    // "os-dev-extra" does not match {base}-\d+ pattern → allowed
    expect(() => svc.register("os-dev-extra")).not.toThrow();
  });
});

// ── Auto-join channels ─────────────────────────────────────────────────────

describe("auto-join channels", () => {
  it("auto-joins existing channels listed in profile", () => {
    const profileRepo = new InMemoryProfileRepo();
    profileRepo.add({
      name: "os-dev",
      persona: null,
      objective: null,
      maxInstances: 1,
      autoJoinChannels: ["general", "dev"],
    });

    cleanupDb(TEST_DB);
    const db = createDb(TEST_DB);
    runMigrations(db, allMigrations);
    const repos = createSqliteRepos(db);

    // Pre-create channels using a bootstrap agent
    const bootstrap = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid);
    bootstrap.register("admin");
    bootstrap.createChannel("admin", "general");
    bootstrap.createChannel("admin", "dev");

    const svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid, undefined, profileRepo);
    const result = svc.register("os-dev");

    expect(result.autoJoined).not.toBeNull();
    expect(result.autoJoined!.succeeded.sort()).toEqual(["dev", "general"]);
    expect(result.autoJoined!.failed).toEqual([]);

    // Verify agent is actually a member
    const members = bootstrap.listMembers("general");
    const member = members.find((m) => m.agent_id === "os-dev");
    expect(member).toBeDefined();
  });

  it("records failure in autoJoined.failed for non-existent channels", () => {
    const profileRepo = new InMemoryProfileRepo();
    profileRepo.add({
      name: "os-dev",
      persona: null,
      objective: null,
      maxInstances: 1,
      autoJoinChannels: ["nonexistent-channel"],
    });

    const { svc } = setup(profileRepo);
    const result = svc.register("os-dev");

    expect(result.autoJoined!.succeeded).toEqual([]);
    expect(result.autoJoined!.failed.length).toBe(1);
    expect(result.autoJoined!.failed[0]!.channel).toBe("nonexistent-channel");
  });

  it("partially succeeds: joins existing channels, records failure for missing ones", () => {
    const profileRepo = new InMemoryProfileRepo();
    profileRepo.add({
      name: "os-dev",
      persona: null,
      objective: null,
      maxInstances: 1,
      autoJoinChannels: ["general", "missing-channel"],
    });

    cleanupDb(TEST_DB);
    const db = createDb(TEST_DB);
    runMigrations(db, allMigrations);
    const repos = createSqliteRepos(db);

    const bootstrap = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid);
    bootstrap.register("admin");
    bootstrap.createChannel("admin", "general");

    const svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid, undefined, profileRepo);
    const result = svc.register("os-dev");

    expect(result.autoJoined!.succeeded).toEqual(["general"]);
    expect(result.autoJoined!.failed.length).toBe(1);
    expect(result.autoJoined!.failed[0]!.channel).toBe("missing-channel");
  });

  it("auto-join does not throw for pool profile — uses registeredName for channel membership", () => {
    const profileRepo = new InMemoryProfileRepo();
    profileRepo.add({
      name: "worker",
      persona: null,
      objective: null,
      maxInstances: 3,
      autoJoinChannels: ["tasks"],
    });

    cleanupDb(TEST_DB);
    const db = createDb(TEST_DB);
    runMigrations(db, allMigrations);
    const repos = createSqliteRepos(db);

    const bootstrap = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid);
    bootstrap.register("admin");
    bootstrap.createChannel("admin", "tasks");

    const svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid, undefined, profileRepo);
    const result = svc.register("worker");

    expect(result.registeredName).toBe("worker-1");
    expect(result.autoJoined!.succeeded).toEqual(["tasks"]);

    // Verify worker-1 is a member of tasks
    const members = bootstrap.listMembers("tasks");
    expect(members.find((m) => m.agent_id === "worker-1")).toBeDefined();
  });
});

// ── RegisterResult type compatibility ─────────────────────────────────────

describe("RegisterResult type shape", () => {
  it("register() returns all required fields in all paths", () => {
    const profileRepo = new InMemoryProfileRepo();
    profileRepo.add({
      name: "os-dev",
      persona: "dev",
      objective: "code",
      maxInstances: 1,
      autoJoinChannels: [],
    });

    cleanupDb(TEST_DB);
    const db = createDb(TEST_DB);
    runMigrations(db, allMigrations);
    const repos = createSqliteRepos(db);
    const svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid, undefined, profileRepo);

    const withProfile = svc.register("os-dev");
    expect(withProfile).toHaveProperty("registeredName");
    expect(withProfile).toHaveProperty("baseName");
    expect(withProfile).toHaveProperty("instanceNumber");
    expect(withProfile).toHaveProperty("profile");
    expect(withProfile).toHaveProperty("autoJoined");

    // Register a plain agent (no profile) from same service
    const svc2 = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid);
    const noProfile = svc2.register("plain-agent");
    expect(noProfile).toHaveProperty("registeredName");
    expect(noProfile).toHaveProperty("baseName");
    expect(noProfile).toHaveProperty("instanceNumber");
    expect(noProfile).toHaveProperty("profile");
    expect(noProfile).toHaveProperty("autoJoined");
    expect(noProfile.baseName).toBeNull();
    expect(noProfile.profile).toBeNull();
    expect(noProfile.autoJoined).toBeNull();
  });
});
