import { describe, it, expect, afterEach } from "bun:test";
import { MessagingService } from "../../../src/core/messaging/service";
import { createSqliteRepos } from "../../../src/storage/sqlite";
import { createDb } from "../../../src/storage/sqlite/db";
import {
  runMigrations,
  allMigrations,
} from "../../../src/storage/sqlite/migrations";
import { cleanupDb } from "../../helpers/db";
import type { ProfileRepository } from "../../../src/core/ports";
import type { AgentProfile } from "../../../src/core/profiles/types";

const TEST_DB = `/tmp/octo-santa-test-pool-mentions-${process.pid}.sqlite`;

// ── In-memory ProfileRepository ────────────────────────────────────────────

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

// ── Setup helper ───────────────────────────────────────────────────────────

function setup(profileRepo?: ProfileRepository) {
  cleanupDb(TEST_DB);
  const db = createDb(TEST_DB);
  runMigrations(db, allMigrations);
  const repos = createSqliteRepos(db);
  const capturingDispatch = makeCapturingDispatch();
  const svc = new MessagingService(
    repos.agents,
    repos.channels,
    repos.messages,
    repos.cursors,
    process.pid,
    capturingDispatch,
    profileRepo
  );
  return { db, repos, svc, dispatched: capturingDispatch.dispatched };
}

afterEach(() => cleanupDb(TEST_DB));

/**
 * Inserts a live agent directly into the DB with a given base_name and the
 * current PID so that isAgentActive() returns true.
 * Used to simulate a second pool instance from a "different process" that
 * happens to be alive (same PID — acceptable for unit tests).
 */
function insertLiveAgent(
  db: ReturnType<typeof createDb>,
  agentId: string,
  baseName: string
): void {
  const now = Date.now();
  db.run(
    `INSERT INTO agents (id, created_at, last_seen_at, pid, registered_at, base_name)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [agentId, now, now, process.pid, now, baseName]
  );
}

// ── Pool mention — base name stored, instances notified ───────────────────

describe("pool-wide mention expansion", () => {
  it("@os-dev mention stores base name and dispatches to subscribed live instances", () => {
    const profileRepo = new InMemoryProfileRepo();
    profileRepo.add({
      name: "os-dev",
      persona: null,
      objective: null,
      instructions: null,
      maxInstances: 3,
      autoJoinChannels: [],
    });

    const { svc, db, repos, dispatched } = setup(profileRepo);

    // Bootstrap: create channel and an admin
    svc.register("admin");
    svc.createChannel("admin", "general");

    // Register first pool instance through the service (os-dev-1)
    const r1 = svc.register("os-dev");
    const id1 = r1.registeredName; // "os-dev-1"

    // Insert second instance directly (bypasses same-PID idempotency) so we have two live instances
    insertLiveAgent(db, "os-dev-2", "os-dev");
    const id2 = "os-dev-2";

    // Register os-dev-2 as a known agent via repos.agents so subscribe works
    // (subscribe calls requireRegistered which checks pid = process.pid)
    // We need to use a separate MessagingService for os-dev-2 that shares the same DB
    // Instead, let's subscribe os-dev-2 directly via repos
    const channel = repos.channels.findByName("general")!;
    repos.channels.addMember(id2, channel.id, 0);

    // Subscribe id1 too
    svc.subscribe(id1, "general");

    // Admin sends @os-dev (base name mention)
    const msg = svc.send("admin", "general", `hey @os-dev check this`);

    // The message's stored mentions should contain the raw base name "os-dev"
    const row = db.query("SELECT mentions FROM messages WHERE id = ?").get(msg.id) as { mentions: string } | null;
    expect(row).not.toBeNull();
    const storedMentions = JSON.parse(row!.mentions) as string[];
    expect(storedMentions).toContain("os-dev");

    // Dispatch should have resolved os-dev → [os-dev-1, os-dev-2]
    expect(dispatched.length).toBe(1);
    expect(dispatched[0]!.targetAgents.sort()).toEqual([id1, id2].sort());
  });

  it("@os-dev-1 as direct mention targets only that instance, not the whole pool", () => {
    const profileRepo = new InMemoryProfileRepo();
    profileRepo.add({
      name: "os-dev",
      persona: null,
      objective: null,
      instructions: null,
      maxInstances: 3,
      autoJoinChannels: [],
    });

    const { svc, db, repos, dispatched } = setup(profileRepo);

    svc.register("admin");
    svc.createChannel("admin", "general");

    const r1 = svc.register("os-dev");
    const id1 = r1.registeredName; // "os-dev-1"

    // Second instance inserted directly
    insertLiveAgent(db, "os-dev-2", "os-dev");
    const channel = repos.channels.findByName("general")!;
    repos.channels.addMember("os-dev-2", channel.id, 0);
    svc.subscribe(id1, "general");

    // Direct mention by full instance name
    svc.send("admin", "general", `hey @${id1} only you`);

    expect(dispatched.length).toBe(1);
    expect(dispatched[0]!.targetAgents).toEqual([id1]);
  });

  it("membership filter: @os-dev only notifies pool instances subscribed to the channel", () => {
    const profileRepo = new InMemoryProfileRepo();
    profileRepo.add({
      name: "os-dev",
      persona: null,
      objective: null,
      instructions: null,
      maxInstances: 3,
      autoJoinChannels: [],
    });

    const { svc, db, repos, dispatched } = setup(profileRepo);

    svc.register("admin");
    svc.createChannel("admin", "general");

    const r1 = svc.register("os-dev"); // os-dev-1
    const id1 = r1.registeredName;

    // os-dev-2 is live but NOT subscribed to the channel
    insertLiveAgent(db, "os-dev-2", "os-dev");
    const id2 = "os-dev-2";

    // Only os-dev-1 subscribes; os-dev-2 does NOT
    svc.subscribe(id1, "general");
    // id2 exists and is active (same PID) but is NOT a channel member

    svc.send("admin", "general", "@os-dev all instances should see this");

    expect(dispatched.length).toBe(1);
    // Only id1 is a member — id2 must NOT be in targets
    expect(dispatched[0]!.targetAgents).toEqual([id1]);
    expect(dispatched[0]!.targetAgents).not.toContain(id2);
  });

  it("no dispatch when pool instances are live but none subscribed to channel", () => {
    const profileRepo = new InMemoryProfileRepo();
    profileRepo.add({
      name: "os-dev",
      persona: null,
      objective: null,
      instructions: null,
      maxInstances: 3,
      autoJoinChannels: [],
    });

    const { svc, db, dispatched } = setup(profileRepo);

    svc.register("admin");
    svc.createChannel("admin", "general");

    // Insert live instances but don't subscribe any to general
    insertLiveAgent(db, "os-dev-1", "os-dev");
    insertLiveAgent(db, "os-dev-2", "os-dev");

    svc.send("admin", "general", "@os-dev nobody is subscribed");

    // No subscribed pool members → no dispatch
    expect(dispatched.length).toBe(0);
  });

  it("deduplicates when same agent is targeted by base name AND direct mention", () => {
    const profileRepo = new InMemoryProfileRepo();
    profileRepo.add({
      name: "os-dev",
      persona: null,
      objective: null,
      instructions: null,
      maxInstances: 3,
      autoJoinChannels: [],
    });

    const { svc, dispatched } = setup(profileRepo);

    svc.register("admin");
    svc.createChannel("admin", "general");

    const r1 = svc.register("os-dev"); // os-dev-1
    const id1 = r1.registeredName;
    svc.subscribe(id1, "general");

    // Mention both the base name (@os-dev) and the specific instance (@os-dev-1)
    svc.send("admin", "general", `@os-dev and @${id1} check this`);

    expect(dispatched.length).toBe(1);
    // id1 should appear only once in targetAgents
    const targets = dispatched[0]!.targetAgents;
    expect(targets.filter((t) => t === id1).length).toBe(1);
  });
});
