// tests/hex/core/safety-rails-integration.test.ts
//
// Full lifecycle integration tests for safety rails: hop counter and
// self-mention guard running against real SQLite.

import { describe, it, expect, afterEach } from "bun:test";
import { MessagingService } from "../../../src/core/messaging/service";
import { createSqliteRepos } from "../../../src/storage/sqlite";
import { createDb } from "../../../src/storage/sqlite/db";
import { runMigrations, allMigrations } from "../../../src/storage/sqlite/migrations";
import { cleanupDb } from "../../helpers/db";
import type { Database } from "bun:sqlite";

const TEST_DB = `/tmp/octo-santa-test-safety-integration-${process.pid}.sqlite`;

function setup() {
  cleanupDb(TEST_DB);
  const db = createDb(TEST_DB);
  runMigrations(db, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(
    repos.agents,
    repos.channels,
    repos.messages,
    repos.cursors,
    process.pid
  );
  return { db, repos, svc };
}

afterEach(() => cleanupDb(TEST_DB));

// ── Verification helpers ───────────────────────────────────────────────────

function getHopCount(db: Database, channelName: string): number {
  const row = db
    .query<{ hop_count: number }, [string]>(
      "SELECT hop_count FROM channels WHERE name = ?"
    )
    .get(channelName);
  return row?.hop_count ?? -1;
}

function getMessages(db: Database, channelName: string) {
  return db
    .query<{ id: number; agent_id: string; content: string }, [string]>(
      "SELECT m.id, m.agent_id, m.content FROM messages m JOIN channels c ON m.channel_id = c.id WHERE c.name = ? ORDER BY m.id"
    )
    .all(channelName);
}

// ── Test 1: Ping-pong full lifecycle ──────────────────────────────────────

describe("safety rails integration - ping-pong lifecycle", () => {
  it("two agents ping-pong until hop limit, /continue, then human reset", () => {
    const { db, svc } = setup();

    // Step 1: Create channel with explicit max_hops=4 (test the hop limit mechanism at a low value)
    svc.register("agent-a");
    svc.register("agent-b");
    const channel = svc.createChannel("agent-a", "test-channel", 4);
    svc.subscribe("agent-b", "test-channel");

    // Step 2: Ping-pong to hop=4
    svc.send("agent-a", "test-channel", "hop 1"); // hop 1
    svc.send("agent-b", "test-channel", "hop 2"); // hop 2
    svc.send("agent-a", "test-channel", "hop 3"); // hop 3
    svc.send("agent-b", "test-channel", "hop 4"); // hop 4

    expect(getHopCount(db, "test-channel")).toBe(4);

    // Step 3: Agent A tries to send (hop 5) — blocked
    expect(() => svc.send("agent-a", "test-channel", "hop 5 - should fail")).toThrow(
      "Hop limit reached (4/4) in #test-channel. Message dropped. Only a human can /continue."
    );

    // Step 4: Verify _system message exists with hop limit text
    const messages = getMessages(db, "test-channel");
    const systemMsgs = messages.filter((m) => m.agent_id === "_system");
    expect(systemMsgs.length).toBe(1);
    expect(systemMsgs[0]!.content).toBe(
      "hop limit reached (4/4) in #test-channel -- message from @agent-a blocked. Waiting for human input."
    );

    // Step 5: /continue +4 — hop_count decremented by 4
    const continueResult = svc.continueChannel("agent-a", "test-channel", 4);
    expect(continueResult.hopCount).toBe(0);
    expect(continueResult.maxHops).toBe(4);
    expect(continueResult.bumped).toBe(4);
    expect(getHopCount(db, "test-channel")).toBe(0);

    // Step 6: Agent A can send again after /continue
    expect(() => svc.send("agent-a", "test-channel", "back in action")).not.toThrow();
    expect(getHopCount(db, "test-channel")).toBe(1);

    // Step 7: Human sends { human: true } → hop_count reset to 0
    svc.send("agent-a", "test-channel", "a human speaks", { human: true });
    expect(getHopCount(db, "test-channel")).toBe(0);

    // Step 8: Verify all messages in correct order (hop1..hop4, _system, back-in-action, human)
    const allMsgs = getMessages(db, "test-channel");
    const agentMsgs = allMsgs.filter((m) => m.agent_id !== "_system");
    expect(agentMsgs[0]!.content).toBe("hop 1");
    expect(agentMsgs[0]!.agent_id).toBe("agent-a");
    expect(agentMsgs[1]!.content).toBe("hop 2");
    expect(agentMsgs[1]!.agent_id).toBe("agent-b");
    expect(agentMsgs[2]!.content).toBe("hop 3");
    expect(agentMsgs[2]!.agent_id).toBe("agent-a");
    expect(agentMsgs[3]!.content).toBe("hop 4");
    expect(agentMsgs[3]!.agent_id).toBe("agent-b");
    expect(agentMsgs[4]!.content).toBe("back in action");
    expect(agentMsgs[4]!.agent_id).toBe("agent-a");
    expect(agentMsgs[5]!.content).toBe("a human speaks");
    expect(agentMsgs[5]!.agent_id).toBe("agent-a");

    // _system notice appears after hop 4 messages
    const systemIdx = allMsgs.findIndex((m) => m.agent_id === "_system");
    const hop4Idx = allMsgs.findIndex((m) => m.content === "hop 4");
    const backIdx = allMsgs.findIndex((m) => m.content === "back in action");
    expect(systemIdx).toBeGreaterThan(hop4Idx);
    expect(backIdx).toBeGreaterThan(systemIdx);
  });
});

// ── Test 2: Custom max_hops on channel creation ───────────────────────────

describe("safety rails integration - custom max_hops", () => {
  it("channel with maxHops=2 blocks on third send", () => {
    const { db, svc } = setup();

    // Step 1: Create channel with maxHops=2
    svc.register("agent-a");
    svc.createChannel("agent-a", "tight-channel", 2);

    // Step 2: Agent sends twice — succeeds
    expect(() => svc.send("agent-a", "tight-channel", "send 1")).not.toThrow();
    expect(() => svc.send("agent-a", "tight-channel", "send 2")).not.toThrow();
    expect(getHopCount(db, "tight-channel")).toBe(2);

    // Step 3: Third send — blocked
    expect(() => svc.send("agent-a", "tight-channel", "send 3")).toThrow(
      "Hop limit reached (2/2) in #tight-channel. Message dropped. Only a human can /continue."
    );

    // Verify blocked message was NOT inserted
    const msgs = getMessages(db, "tight-channel");
    const agentMsgs = msgs.filter((m) => m.agent_id === "agent-a");
    expect(agentMsgs.length).toBe(2);
    expect(agentMsgs.some((m) => m.content === "send 3")).toBe(false);

    // Verify _system notice was posted
    const systemMsgs = msgs.filter((m) => m.agent_id === "_system");
    expect(systemMsgs.length).toBe(1);
    expect(systemMsgs[0]!.content).toBe(
      "hop limit reached (2/2) in #tight-channel -- message from @agent-a blocked. Waiting for human input."
    );
  });
});

// ── Test 3: Self-mention blocked ──────────────────────────────────────────

describe("safety rails integration - self-mention blocked", () => {
  it("agent sends message containing @self - error thrown, no message inserted", () => {
    const { db, svc } = setup();

    // Step 1: Register agent and create channel
    svc.register("agent-x");
    svc.createChannel("agent-x", "self-mention-channel");

    // Step 2: Agent sends message containing @self — error thrown
    expect(() =>
      svc.send("agent-x", "self-mention-channel", "hey @agent-x look at this")
    ).toThrow("Cannot @mention yourself in a message");

    // Step 3: Verify no message was inserted
    const msgs = getMessages(db, "self-mention-channel");
    expect(msgs.length).toBe(0);

    // Hop count should also remain at 0 (self-mention check happens before hop increment)
    expect(getHopCount(db, "self-mention-channel")).toBe(0);
  });
});

// ── Test 4: DM hop counter ────────────────────────────────────────────────

describe("safety rails integration - DM hop counter", () => {
  it("two agents DM back and forth and hit explicit limit (channel pre-created with max_hops=4)", () => {
    const { db, svc } = setup();

    // Step 1: Register two agents
    svc.register("dm-alice");
    svc.register("dm-bob");

    const dmName = ["dm-alice", "dm-bob"].sort().join(",");

    // Pre-create DM channel with explicit max_hops=4 so the hop-limit mechanism
    // can be exercised without sending 50 DMs. directMessage() will find this
    // channel via ON CONFLICT DO NOTHING and use its existing limit.
    svc.createChannel("dm-alice", dmName, 4);

    // Step 2: Send 4 DMs alternating — should succeed
    svc.directMessage("dm-alice", "dm-bob", "hello bob");   // hop 1
    svc.directMessage("dm-bob", "dm-alice", "hello alice"); // hop 2
    svc.directMessage("dm-alice", "dm-bob", "how are you"); // hop 3
    svc.directMessage("dm-bob", "dm-alice", "doing well");  // hop 4

    expect(getHopCount(db, dmName)).toBe(4);

    // Step 3: Fifth DM hits the configured limit (4)
    expect(() => svc.directMessage("dm-alice", "dm-bob", "one more")).toThrow(
      `Hop limit reached (4/4) in #${dmName}. Message dropped. Only a human can /continue.`
    );

    // Verify _system notice was posted in the DM channel
    const msgs = getMessages(db, dmName);
    const systemMsgs = msgs.filter((m) => m.agent_id === "_system");
    expect(systemMsgs.length).toBe(1);
    expect(systemMsgs[0]!.content).toContain("hop limit reached (4/4)");
    expect(systemMsgs[0]!.content).toContain("Waiting for human input.");

    // Hop count stays at 4
    expect(getHopCount(db, dmName)).toBe(4);

    // /continue allows more DMs
    svc.continueChannel("dm-alice", dmName, 4);
    expect(getHopCount(db, dmName)).toBe(0);

    expect(() => svc.directMessage("dm-alice", "dm-bob", "resumed")).not.toThrow();
    expect(getHopCount(db, dmName)).toBe(1);
  });
});
