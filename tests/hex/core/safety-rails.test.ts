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
import type { Database } from "bun:sqlite";

const TEST_DB = `/tmp/octo-santa-test-safety-rails-${process.pid}.sqlite`;

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

// ── Setup helper ───────────────────────────────────────────────────────────

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
    undefined,
    profileRepo
  );
  return { db, repos, svc };
}

afterEach(() => cleanupDb(TEST_DB));

// ── Self-mention guard ─────────────────────────────────────────────────────

describe("self-mention guard", () => {
  it("send() with @self mention throws 'Cannot @mention yourself in a message'", () => {
    const { svc } = setup();

    svc.register("alice");
    svc.createChannel("alice", "general");

    expect(() => svc.send("alice", "general", "hey @alice check this out")).toThrow(
      "Cannot @mention yourself in a message"
    );
  });

  it("send() with @other-agent mention succeeds (not a self-mention)", () => {
    const { svc } = setup();

    svc.register("alice");
    svc.register("bob");
    svc.createChannel("alice", "general");

    expect(() => svc.send("alice", "general", "hey @bob check this out")).not.toThrow();
  });

  it("send() with @pool-base-name mention by pool instance is NOT a self-mention", () => {
    const profileRepo = new InMemoryProfileRepo();
    profileRepo.add({
      name: "os-dev",
      persona: null,
      objective: null,
      instructions: null,
      maxInstances: 3,
      autoJoinChannels: [],
    });

    const { svc } = setup(profileRepo);

    svc.register("admin");
    svc.createChannel("admin", "general");

    // Register pool instance (os-dev -> os-dev-1)
    const r1 = svc.register("os-dev");
    const instanceId = r1.registeredName; // "os-dev-1"
    svc.subscribe(instanceId, "general");

    // os-dev-1 sends @os-dev (pool base name) - should NOT be a self-mention
    // because extractMentions stores "os-dev" (base name), not "os-dev-1" (instance)
    expect(() =>
      svc.send(instanceId, "general", "hey @os-dev all instances check this")
    ).not.toThrow();
  });

  it("directMessage() with @self mention throws 'Cannot @mention yourself in a message'", () => {
    const { svc } = setup();

    svc.register("alice");
    svc.register("bob");

    expect(() =>
      svc.directMessage("alice", "bob", "hey @alice I am talking to myself")
    ).toThrow("Cannot @mention yourself in a message");
  });
});

// ── Hop counter ────────────────────────────────────────────────────────────

function getHopCount(db: Database, channelName: string): number {
  const row = db
    .query<{ hop_count: number }, [string]>(
      "SELECT hop_count FROM channels WHERE name = ?"
    )
    .get(channelName);
  return row?.hop_count ?? -1;
}

function countMessages(db: Database, channelId: number): number {
  const row = db
    .query<{ cnt: number }, [number]>(
      "SELECT COUNT(*) as cnt FROM messages WHERE channel_id = ?"
    )
    .get(channelId);
  return row?.cnt ?? 0;
}

function getSystemMessages(db: Database, channelId: number) {
  return db
    .query<{ id: number; content: string }, [number]>(
      "SELECT id, content FROM messages WHERE channel_id = ? AND agent_id = '_system'"
    )
    .all(channelId);
}

describe("hop counter", () => {
  it("agent message increments hop counter from 0 to 1", () => {
    const { db, svc } = setup();

    svc.register("alice");
    const channel = svc.createChannel("alice", "general");

    expect(getHopCount(db, "general")).toBe(0);

    svc.send("alice", "general", "hello");

    expect(getHopCount(db, "general")).toBe(1);
  });

  it("agent message at limit (4/4) throws hop limit error and message NOT inserted", () => {
    const { db, svc } = setup();

    svc.register("alice");
    // Create channel with maxHops=4
    const channel = svc.createChannel("alice", "general", 4);
    // Send 4 messages to hit the limit
    svc.send("alice", "general", "msg 1");
    svc.send("alice", "general", "msg 2");
    svc.send("alice", "general", "msg 3");
    svc.send("alice", "general", "msg 4");

    expect(getHopCount(db, "general")).toBe(4);

    // The 5th send should be blocked
    expect(() => svc.send("alice", "general", "msg 5")).toThrow(
      "Hop limit reached (4/4) in #general. Message dropped. Only a human can /continue."
    );

    // Blocked message was NOT inserted
    const rows = db
      .query<{ content: string }, [number]>(
        "SELECT content FROM messages WHERE channel_id = ? AND agent_id = 'alice'"
      )
      .all(channel.id);
    expect(rows.some((r) => r.content === "msg 5")).toBe(false);
  });

  it("agent message at limit posts _system notice with blocked message info", () => {
    const { db, svc } = setup();

    svc.register("alice");
    const channel = svc.createChannel("alice", "general", 4);
    svc.send("alice", "general", "msg 1");
    svc.send("alice", "general", "msg 2");
    svc.send("alice", "general", "msg 3");
    svc.send("alice", "general", "msg 4");

    expect(() => svc.send("alice", "general", "msg 5")).toThrow();

    const notices = getSystemMessages(db, channel.id);
    expect(notices.length).toBe(1);
    expect(notices[0]!.content).toBe(
      "hop limit reached (4/4) in #general -- message from @alice blocked. Waiting for human input."
    );
  });

  it("human message resets hop counter to 0", () => {
    const { db, svc } = setup();

    svc.register("alice");
    svc.createChannel("alice", "general", 4);
    svc.send("alice", "general", "msg 1");
    svc.send("alice", "general", "msg 2");

    expect(getHopCount(db, "general")).toBe(2);

    // Human send resets counter
    svc.send("alice", "general", "human says hi", { human: true });

    expect(getHopCount(db, "general")).toBe(0);
  });

  it("human message after limit resets and succeeds", () => {
    const { db, svc } = setup();

    svc.register("alice");
    const channel = svc.createChannel("alice", "general", 2);
    svc.send("alice", "general", "msg 1");
    svc.send("alice", "general", "msg 2");

    // Now blocked
    expect(() => svc.send("alice", "general", "blocked")).toThrow();

    // Human resets
    expect(() =>
      svc.send("alice", "general", "human resets", { human: true })
    ).not.toThrow();

    expect(getHopCount(db, "general")).toBe(0);

    // Agent can send again
    expect(() => svc.send("alice", "general", "back in action")).not.toThrow();
    expect(getHopCount(db, "general")).toBe(1);
  });

  it("multiple agent messages increment counter correctly 0->1->2->3->4->blocked", () => {
    const { db, svc } = setup();

    svc.register("alice");
    const channel = svc.createChannel("alice", "general", 4);

    for (let i = 1; i <= 4; i++) {
      svc.send("alice", "general", `msg ${i}`);
      expect(getHopCount(db, "general")).toBe(i);
    }

    expect(() => svc.send("alice", "general", "msg 5")).toThrow(
      "Hop limit reached (4/4)"
    );
    // Counter stays at 4 (not incremented on blocked message)
    expect(getHopCount(db, "general")).toBe(4);
  });

  it("_system notices do NOT increment hop counter", () => {
    const { db, svc } = setup();

    svc.register("alice");
    const channel = svc.createChannel("alice", "general", 4);
    svc.send("alice", "general", "msg 1");
    svc.send("alice", "general", "msg 2");
    svc.send("alice", "general", "msg 3");
    svc.send("alice", "general", "msg 4");

    expect(getHopCount(db, "general")).toBe(4);

    // Trigger blocked send which posts _system notice
    expect(() => svc.send("alice", "general", "blocked")).toThrow();

    // Hop count stays at 4, not incremented by _system notice
    expect(getHopCount(db, "general")).toBe(4);
  });

  it("DM hop counter: two agents DMing increment DM channel hop counter", () => {
    const { db, svc } = setup();

    svc.register("alice");
    svc.register("bob");

    // alice DMs bob - creates DM channel
    svc.directMessage("alice", "bob", "hello bob");

    // Determine the DM channel name
    const dmName = ["alice", "bob"].sort().join(",");
    expect(getHopCount(db, dmName)).toBe(1);

    // bob DMs alice - uses same channel
    svc.directMessage("bob", "alice", "hello alice");
    expect(getHopCount(db, dmName)).toBe(2);
  });
});

// ── continueChannel ────────────────────────────────────────────────────────

describe("continueChannel", () => {
  it("continueChannel at hop_count=4 with amount=4 decrements to 0 and returns correct result", () => {
    const { db, svc } = setup();

    svc.register("alice");
    svc.createChannel("alice", "test-channel", 4);
    svc.send("alice", "test-channel", "msg 1");
    svc.send("alice", "test-channel", "msg 2");
    svc.send("alice", "test-channel", "msg 3");
    svc.send("alice", "test-channel", "msg 4");

    expect(getHopCount(db, "test-channel")).toBe(4);

    const result = svc.continueChannel("alice", "test-channel", 4);

    expect(result).toEqual({ channel: "test-channel", hopCount: 0, maxHops: 4, bumped: 4 });
    expect(getHopCount(db, "test-channel")).toBe(0);
  });

  it("continueChannel at hop_count=4 with amount=2 decrements to 2", () => {
    const { db, svc } = setup();

    svc.register("alice");
    svc.createChannel("alice", "test-channel", 4);
    svc.send("alice", "test-channel", "msg 1");
    svc.send("alice", "test-channel", "msg 2");
    svc.send("alice", "test-channel", "msg 3");
    svc.send("alice", "test-channel", "msg 4");

    const result = svc.continueChannel("alice", "test-channel", 2);

    expect(result.hopCount).toBe(2);
    expect(result.bumped).toBe(2);
    expect(getHopCount(db, "test-channel")).toBe(2);
  });

  it("continueChannel with no amount uses default of 4", () => {
    const { db, svc } = setup();

    svc.register("alice");
    svc.createChannel("alice", "test-channel", 4);
    svc.send("alice", "test-channel", "msg 1");
    svc.send("alice", "test-channel", "msg 2");
    svc.send("alice", "test-channel", "msg 3");
    svc.send("alice", "test-channel", "msg 4");

    const result = svc.continueChannel("alice", "test-channel");

    expect(result.bumped).toBe(4);
    expect(result.hopCount).toBe(0);
    expect(getHopCount(db, "test-channel")).toBe(0);
  });

  it("continueChannel on nonexistent channel throws channel not found", () => {
    const { svc } = setup();

    svc.register("alice");
    expect(() => svc.continueChannel("alice", "nonexistent")).toThrow(
      'Channel "nonexistent" not found'
    );
  });

  it("after continueChannel, agents can send again until new limit", () => {
    const { db, svc } = setup();

    svc.register("alice");
    svc.createChannel("alice", "test-channel", 4);
    svc.send("alice", "test-channel", "msg 1");
    svc.send("alice", "test-channel", "msg 2");
    svc.send("alice", "test-channel", "msg 3");
    svc.send("alice", "test-channel", "msg 4");

    // Channel is now blocked
    expect(() => svc.send("alice", "test-channel", "blocked")).toThrow("Hop limit reached");

    // /continue gives 4 more hops
    svc.continueChannel("alice", "test-channel", 4);

    // Agent can send again
    expect(() => svc.send("alice", "test-channel", "back in action")).not.toThrow();
    expect(getHopCount(db, "test-channel")).toBe(1);
  });

  it("continueChannel on non-blocked channel (hop_count=1) decrements to 0, giving extra headroom", () => {
    const { db, svc } = setup();

    svc.register("alice");
    svc.createChannel("alice", "test-channel", 4);
    svc.send("alice", "test-channel", "msg 1");

    expect(getHopCount(db, "test-channel")).toBe(1);

    const result = svc.continueChannel("alice", "test-channel", 4);

    // hop_count decrements from 1 to 0 (clamped at 0, not negative)
    expect(result.hopCount).toBe(0);
    expect(getHopCount(db, "test-channel")).toBe(0);
  });

  it("continueChannel throws for unregistered agent", () => {
    const { svc } = setup();

    svc.register("alice");
    svc.createChannel("alice", "test-channel");

    expect(() => svc.continueChannel("nobody", "test-channel")).toThrow(
      'Agent "nobody" must call messaging_register'
    );
  });

  it("continueChannel rejects amount < 1", () => {
    const { svc } = setup();

    svc.register("alice");
    svc.createChannel("alice", "test-channel");

    expect(() => svc.continueChannel("alice", "test-channel", 0)).toThrow(
      "amount must be at least 1"
    );
    expect(() => svc.continueChannel("alice", "test-channel", -1)).toThrow(
      "amount must be at least 1"
    );
  });
});

describe("validation", () => {
  it("createChannel rejects maxHops < 1", () => {
    const { svc } = setup();

    svc.register("alice");

    expect(() => svc.createChannel("alice", "blocked-ch", 0)).toThrow(
      "maxHops must be at least 1"
    );
    expect(() => svc.createChannel("alice", "blocked-ch", -1)).toThrow(
      "maxHops must be at least 1"
    );
  });

  it("createChannel allows maxHops > 50 (upper bound enforced at transport)", () => {
    const { svc } = setup();

    svc.register("alice");

    const ch = svc.createChannel("alice", "stress-ch", 100);
    expect(ch.max_hops).toBe(100);
  });
});

describe("_system notice deduplication", () => {
  it("repeated blocked sends emit only one _system notice", () => {
    const { db, svc } = setup();

    svc.register("alice");
    svc.createChannel("alice", "test-channel", 2);
    svc.subscribe("alice", "test-channel");

    svc.send("alice", "test-channel", "msg 1");
    svc.send("alice", "test-channel", "msg 2");

    // Three blocked attempts
    expect(() => svc.send("alice", "test-channel", "blocked 1")).toThrow("Hop limit reached");
    expect(() => svc.send("alice", "test-channel", "blocked 2")).toThrow("Hop limit reached");
    expect(() => svc.send("alice", "test-channel", "blocked 3")).toThrow("Hop limit reached");

    // Only one _system notice should exist
    const allMsgs = db.query("SELECT * FROM messages WHERE channel_id = (SELECT id FROM channels WHERE name = 'test-channel') AND agent_id = '_system'").all();
    expect(allMsgs.length).toBe(1);
  });
});
