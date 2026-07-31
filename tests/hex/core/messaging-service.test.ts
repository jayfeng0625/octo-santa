import { describe, it, expect, afterEach } from "bun:test";
import { MessagingService } from "../../../src/core/messaging/service";
import { ChannelNotFoundError } from "../../../src/core/messaging/errors";
import { createSqliteRepos } from "../../../src/storage/sqlite";
import { createDb } from "../../../src/storage/sqlite/db";
import { runMigrations, allMigrations } from "../../../src/storage/sqlite/migrations";
import { cleanupDb } from "../../helpers/db";

const TEST_DB = `/tmp/octo-santa-test-hex-messaging-svc-${process.pid}.sqlite`;

function setup() {
  cleanupDb(TEST_DB);
  const db = createDb(TEST_DB);
  runMigrations(db, allMigrations);
  const repos = createSqliteRepos(db);
  const svc = new MessagingService(
    repos.agents,
    repos.channels,
    repos.messages,
    process.pid
  );
  return { db, repos, svc };
}

afterEach(() => cleanupDb(TEST_DB));

describe("MessagingService", () => {
  // ── register + send + read flow ────────────────────────────────

  describe("register + send + read flow", () => {
    it("registers, creates channel, sends, and reads messages", () => {
      const { svc } = setup();

      const agent = svc.register("alice");
      expect(agent.id).toBe("alice");
      expect(agent.pid).toBe(process.pid);

      const channel = svc.createChannel("alice", "general");
      expect(channel.name).toBe("general");

      svc.subscribe("alice", "general");

      // Register bob and have bob send a message
      svc.register("bob");
      svc.subscribe("bob", "general");
      const msg = svc.send("bob", "general", "hello @alice");
      expect(msg.agent_id).toBe("bob");
      expect(msg.content).toBe("hello @alice");

      // Alice reads — should see bob's message
      const messages = svc.read("alice", "general");
      expect(messages.length).toBe(1);
      expect(messages[0]!.content).toBe("hello @alice");
      expect(messages[0]!.agent_id).toBe("bob");

      // Second read — no new messages
      const messages2 = svc.read("alice", "general");
      expect(messages2.length).toBe(0);
    });
  });

  // ── send throws when not registered ────────────────────────────

  describe("send throws when not registered", () => {
    it("throws if agent has not registered", () => {
      const { svc } = setup();
      svc.register("alice");
      svc.createChannel("alice", "general");

      expect(() => svc.send("bob", "general", "hi")).toThrow(
        'Agent "bob" must call messaging_register before using messaging tools'
      );
    });
  });

  // ── directMessage ──────────────────────────────────────────────

  describe("directMessage", () => {
    it("creates DM channel and sends message", () => {
      const { svc } = setup();

      svc.register("alice");
      svc.register("bob");

      const msg = svc.directMessage("alice", "bob", "hey bob");
      expect(msg.agent_id).toBe("alice");
      expect(msg.content).toBe("hey bob");

      // Channel name should be sorted
      const channels = svc.listChannels();
      const dm = channels.find((c) => c.name === "alice,bob");
      expect(dm).toBeDefined();

      // Bob can read the DM
      const bobMessages = svc.read("bob", "alice,bob");
      expect(bobMessages.length).toBe(1);
      expect(bobMessages[0]!.content).toBe("hey bob");
    });

    it("rejects self-DM", () => {
      const { svc } = setup();
      svc.register("alice");

      expect(() =>
        svc.directMessage("alice", "alice", "talking to myself")
      ).toThrow("Cannot DM yourself");
    });

    it("rejects DM to non-existent agent", () => {
      const { svc } = setup();
      svc.register("alice");

      expect(() =>
        svc.directMessage("alice", "ghost", "hello?")
      ).toThrow('Agent "ghost" not found');
    });

    it("rejects empty content", () => {
      const { svc } = setup();
      svc.register("alice");
      svc.register("bob");

      expect(() =>
        svc.directMessage("alice", "bob", "   ")
      ).toThrow("message content must not be empty");
    });
  });

  // ── subscribe enforces DM access ──────────────────────────────

  describe("subscribe enforces DM access", () => {
    it("rejects third-party subscription to DM channel", () => {
      const { svc } = setup();

      svc.register("alice");
      svc.register("bob");
      svc.register("eve");

      svc.directMessage("alice", "bob", "secret");

      expect(() => svc.subscribe("eve", "alice,bob")).toThrow(
        'DM channel "alice,bob" is private to alice and bob'
      );
    });

    it("allows DM participant to subscribe", () => {
      const { svc } = setup();

      svc.register("alice");
      svc.register("bob");

      svc.directMessage("alice", "bob", "hello");

      // Should not throw — alice is a participant
      expect(() => svc.subscribe("alice", "alice,bob")).not.toThrow();
    });
  });

  // ── bug #7: subscribe cursor initialization ────────────────────

  describe("bug #7: subscribe cursor initialization", () => {
    it("new subscriber sees pre-existing messages on first read", () => {
      const { svc } = setup();

      svc.register("alice");
      svc.register("bob");
      svc.createChannel("alice", "general");
      svc.subscribe("alice", "general");

      // Alice sends messages BEFORE bob subscribes
      svc.send("alice", "general", "msg 1");
      svc.send("alice", "general", "msg 2");
      svc.send("alice", "general", "msg 3");

      // Bob subscribes after messages exist
      svc.subscribe("bob", "general");

      // Bob should see pre-existing messages (cursor = 0, not maxId)
      const messages = svc.read("bob", "general");
      expect(messages.length).toBe(3);
      expect(messages[0]!.content).toBe("msg 1");
    });

    it("new DM participant sees pre-existing messages", () => {
      const { svc } = setup();

      svc.register("alice");
      svc.register("bob");

      // First DM creates channel and sends message
      svc.directMessage("alice", "bob", "hey bob");

      // Bob reads — should see the initial DM (cursor starts at 0)
      const messages = svc.read("bob", "alice,bob");
      expect(messages.length).toBe(1);
      expect(messages[0]!.content).toBe("hey bob");
    });
  });

  // ── listAgents filters active ──────────────────────────────────

  describe("listAgents", () => {
    it("filters to active agents by default", () => {
      const { svc } = setup();

      svc.register("alice");
      svc.register("bob");

      const active = svc.listAgents();
      expect(active.length).toBe(2);
      expect(active.map((a) => a.id).sort()).toEqual(["alice", "bob"]);
    });

    it("includes stale agents when requested", () => {
      const { svc } = setup();

      svc.register("alice");
      svc.register("bob");
      svc.unregister("bob");

      const all = svc.listAgents(true);
      expect(all.length).toBe(2);

      const active = svc.listAgents();
      // bob has null PID after unregister, so not active
      expect(active.length).toBe(1);
      expect(active[0]!.id).toBe("alice");
    });
  });

  // ── renameChannel ──────────────────────────────────────────────

  describe("renameChannel", () => {
    it("renames a channel and posts announcement", () => {
      const { svc } = setup();

      svc.register("alice");
      svc.register("bob");
      const ch = svc.createChannel("alice", "old-name");
      svc.subscribe("alice", "old-name");
      svc.subscribe("bob", "old-name");

      const renamed = svc.renameChannel("alice", "old-name", "new-name");
      expect(renamed.name).toBe("new-name");
      expect(renamed.id).toBe(ch.id);

      // The announcement message should be readable by other members
      // (readForwardAndAdvance excludes the reader's own messages,
      // so bob reads the announcement posted by alice)
      const messages = svc.read("bob", "new-name");
      expect(messages.length).toBe(1);
      expect(messages[0]!.content).toContain("renamed from");
    });

    it("rename announcement is visible to the renaming agent", () => {
      const { svc } = setup();

      svc.register("alice");
      const ch = svc.createChannel("alice", "old-name");
      svc.subscribe("alice", "old-name");

      svc.renameChannel("alice", "old-name", "new-name");

      // Alice (the renamer) should also see the announcement since it's
      // from "_system", not from alice — bypasses self-exclusion
      const messages = svc.read("alice", "new-name");
      expect(messages.length).toBe(1);
      expect(messages[0]!.content).toContain("renamed from");
      expect(messages[0]!.agent_id).toBe("_system");
    });

    it("rejects renaming a DM channel", () => {
      const { svc } = setup();

      svc.register("alice");
      svc.register("bob");
      svc.directMessage("alice", "bob", "hi");

      expect(() =>
        svc.renameChannel("alice", "alice,bob", "friends")
      ).toThrow("Cannot rename a DM channel");
    });

    it("rejects renaming to a DM-style name", () => {
      const { svc } = setup();

      svc.register("alice");
      svc.createChannel("alice", "general");
      svc.subscribe("alice", "general");

      expect(() =>
        svc.renameChannel("alice", "general", "alice,bob")
      ).toThrow("Cannot rename a channel to a DM-style name");
    });

    it("rejects rename by non-member", () => {
      const { svc } = setup();

      svc.register("alice");
      svc.register("bob");
      svc.createChannel("alice", "private");
      svc.subscribe("alice", "private");

      expect(() =>
        svc.renameChannel("bob", "private", "public")
      ).toThrow('Not a member of channel "private"');
    });

    it("rejects empty new name", () => {
      const { svc } = setup();

      svc.register("alice");
      svc.createChannel("alice", "general");
      svc.subscribe("alice", "general");

      expect(() =>
        svc.renameChannel("alice", "general", "   ")
      ).toThrow("new channel name must not be empty");
    });
  });

  // ── read edge cases ────────────────────────────────────────────

  describe("read edge cases", () => {
    it("throws if channel does not exist", () => {
      const { svc } = setup();
      svc.register("alice");

      expect(() => svc.read("alice", "nonexistent")).toThrow(
        'Channel "nonexistent" does not exist'
      );
    });

    it("throws if not a member", () => {
      const { svc } = setup();
      svc.register("alice");
      svc.register("bob");
      svc.createChannel("alice", "private");
      svc.subscribe("alice", "private");

      expect(() => svc.read("bob", "private")).toThrow(
        'Not a member of channel "private"'
      );
    });

    it("supports history mode with before_id", () => {
      const { svc } = setup();

      svc.register("alice");
      svc.register("bob");
      svc.createChannel("alice", "general");
      svc.subscribe("alice", "general");
      svc.subscribe("bob", "general");

      const msg1 = svc.send("bob", "general", "first");
      const msg2 = svc.send("bob", "general", "second");
      svc.send("bob", "general", "third");

      // History mode: get messages before msg2's successor
      const history = svc.read("alice", "general", {
        before_id: msg2.id + 1,
        limit: 10,
      });
      // Should include messages before msg2+1, excluding alice's own (none)
      expect(history.length).toBe(2);
      expect(history[0]!.content).toBe("first");
      expect(history[1]!.content).toBe("second");
    });
  });

  // ── validation ─────────────────────────────────────────────────

  describe("validation", () => {
    it("rejects reserved agent names", () => {
      const { svc } = setup();

      expect(() => svc.register("all")).toThrow("reserved for broadcast mentions");
      expect(() => svc.register("here")).toThrow("reserved for broadcast mentions");
    });

    it("rejects invalid agent name characters", () => {
      const { svc } = setup();

      expect(() => svc.register("agent name")).toThrow("must match");
      expect(() => svc.register("agent@name")).toThrow("must match");
    });

    it("rejects empty agent name", () => {
      const { svc } = setup();

      expect(() => svc.register("  ")).toThrow("agent_id must not be empty");
    });

    it("rejects empty channel name", () => {
      const { svc } = setup();
      svc.register("alice");

      expect(() => svc.createChannel("alice", "  ")).toThrow(
        "channel name must not be empty"
      );
    });

    it("rejects empty message content", () => {
      const { svc } = setup();
      svc.register("alice");
      svc.createChannel("alice", "general");

      expect(() => svc.send("alice", "general", "  ")).toThrow(
        "message content must not be empty"
      );
    });
  });

  // ── send DM access control ─────────────────────────────────────

  describe("send DM access control", () => {
    it("rejects third-party send to DM channel", () => {
      const { svc } = setup();

      svc.register("alice");
      svc.register("bob");
      svc.register("eve");

      svc.directMessage("alice", "bob", "private stuff");

      expect(() =>
        svc.send("eve", "alice,bob", "eavesdrop")
      ).toThrow('DM channel "alice,bob" is private to alice and bob');
    });
  });

  // ── listMembers ────────────────────────────────────────────────

  describe("listMembers", () => {
    it("returns members with active status", () => {
      const { svc } = setup();

      svc.register("alice");
      svc.register("bob");
      svc.createChannel("alice", "general");
      svc.subscribe("alice", "general");
      svc.subscribe("bob", "general");

      const members = svc.listMembers("general");
      expect(members.length).toBe(2);
      expect(members.map((m) => m.agent_id).sort()).toEqual(["alice", "bob"]);
      expect(members.every((m) => m.active)).toBe(true);
    });

    it("returns empty for non-existent channel", () => {
      const { svc } = setup();
      const members = svc.listMembers("nonexistent");
      expect(members).toEqual([]);
    });
  });

  // ── readHistory (pure history read for MCP resources) ──────────

  describe("readHistory", () => {
    it("returns the newest messages ascending, including the reader's own", () => {
      const { svc } = setup();
      svc.register("alice");
      svc.register("bob");
      svc.createChannel("alice", "general");
      svc.subscribe("bob", "general");
      svc.send("alice", "general", "from-alice");
      svc.send("bob", "general", "from-bob");

      const history = svc.readHistory("alice", "general");
      expect(history.map((m) => m.content)).toEqual(["from-alice", "from-bob"]);
    });

    it("caps the window at the given limit, keeping the newest", () => {
      const { svc } = setup();
      svc.register("alice");
      svc.createChannel("alice", "general");
      for (let i = 1; i <= 5; i++) svc.send("alice", "general", `msg-${i}`);

      const history = svc.readHistory("alice", "general", 2);
      expect(history.map((m) => m.content)).toEqual(["msg-4", "msg-5"]);
    });

    it("never advances the unread cursor — read() still returns everything", () => {
      const { svc } = setup();
      svc.register("alice");
      svc.register("bob");
      svc.createChannel("alice", "general");
      svc.subscribe("bob", "general");
      svc.send("alice", "general", "unread-1");

      const history = svc.readHistory("bob", "general");
      expect(history.length).toBe(1);

      const firstRead = svc.read("bob", "general");
      expect(firstRead.map((m) => m.content)).toEqual(["unread-1"]);
      const secondRead = svc.read("bob", "general");
      expect(secondRead).toEqual([]);
    });

    it("rejects unregistered agents", () => {
      const { svc } = setup();
      svc.register("alice");
      svc.createChannel("alice", "general");
      expect(() => svc.readHistory("ghost", "general")).toThrow(/messaging_register/);
    });

    it("throws ChannelNotFoundError for unknown channels", () => {
      const { svc } = setup();
      svc.register("alice");
      expect(() => svc.readHistory("alice", "nope")).toThrow(ChannelNotFoundError);
    });

    it("rejects non-members of a channel", () => {
      const { svc } = setup();
      svc.register("alice");
      svc.register("bob");
      svc.createChannel("alice", "general");
      expect(() => svc.readHistory("bob", "general")).toThrow(/Not a member/);
    });

    it("denies DM channels to outsiders even before the membership check", () => {
      const { svc } = setup();
      svc.register("alice");
      svc.register("bob");
      svc.register("carol");
      svc.directMessage("alice", "bob", "secret");

      expect(() => svc.readHistory("carol", "alice,bob")).toThrow(/private to alice and bob/);
    });

    it("allows DM members to read DM history", () => {
      const { svc } = setup();
      svc.register("alice");
      svc.register("bob");
      svc.directMessage("alice", "bob", "secret");

      const history = svc.readHistory("bob", "alice,bob");
      expect(history.map((m) => m.content)).toEqual(["secret"]);
    });
  });
});
