import { describe, it, expect, afterEach } from "bun:test";
import { MessagingService } from "../../../src/core/messaging/service";
import { createSqliteRepos } from "../../../src/storage/sqlite";
import { createDb } from "../../../src/storage/sqlite/db";
import { runMigrations, allMigrations } from "../../../src/storage/sqlite/migrations";
import { createNotificationDispatcher } from "../../../src/notifications/dispatch/dispatcher";
import { cleanupDb } from "../../helpers/db";

const TEST_DB = `/tmp/octo-santa-test-hex-messaging-svc-${process.pid}.sqlite`;

function setup() {
  cleanupDb(TEST_DB);
  const db = createDb(TEST_DB);
  runMigrations(db, allMigrations);
  const repos = createSqliteRepos(db);
  const dispatcher = createNotificationDispatcher();
  const svc = new MessagingService(
    repos.agents,
    repos.channels,
    repos.messages,
    repos.cursors,
    process.pid,
    dispatcher
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

  // ── readRecent ─────────────────────────────────────────────────

  describe("readRecent", () => {
    it("returns chronological messages from all authors", () => {
      const { svc } = setup();

      svc.register("alice");
      svc.register("bob");

      const ch = svc.createChannel("alice", "general");
      svc.subscribe("alice", "general");
      svc.subscribe("bob", "general");

      svc.send("alice", "general", "message 1");
      svc.send("bob", "general", "message 2");
      svc.send("alice", "general", "message 3");

      const recent = svc.readRecent("general", 10);
      expect(recent.length).toBe(3);
      // Should be in chronological order
      expect(recent[0]!.content).toBe("message 1");
      expect(recent[0]!.agent_id).toBe("alice");
      expect(recent[1]!.content).toBe("message 2");
      expect(recent[1]!.agent_id).toBe("bob");
      expect(recent[2]!.content).toBe("message 3");
      expect(recent[2]!.agent_id).toBe("alice");
    });

    it("respects limit parameter", () => {
      const { svc } = setup();

      svc.register("alice");
      const ch = svc.createChannel("alice", "general");
      svc.subscribe("alice", "general");

      svc.send("alice", "general", "msg 1");
      svc.send("alice", "general", "msg 2");
      svc.send("alice", "general", "msg 3");

      const recent = svc.readRecent("general", 2);
      expect(recent.length).toBe(2);
      // Should be the last 2, in chronological order
      expect(recent[0]!.content).toBe("msg 2");
      expect(recent[1]!.content).toBe("msg 3");
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

  // ── pollNewMessages ────────────────────────────────────────────

  describe("pollNewMessages", () => {
    it("returns messages since a given ID", () => {
      const { svc } = setup();

      svc.register("alice");
      svc.register("bob");
      svc.createChannel("alice", "general");
      svc.subscribe("alice", "general");
      svc.subscribe("bob", "general");

      const msg1 = svc.send("alice", "general", "first");
      svc.send("bob", "general", "second");
      svc.send("alice", "general", "third");

      // Poll since msg1 for bob — should exclude bob's own messages
      const newMsgs = svc.pollNewMessages("general", msg1.id, "bob");
      expect(newMsgs.length).toBe(1);
      expect(newMsgs[0]!.content).toBe("third");
    });

    it("returns empty for non-existent channel", () => {
      const { svc } = setup();
      const result = svc.pollNewMessages("nonexistent", 0, "alice");
      expect(result).toEqual([]);
    });
  });

  // ── getCursorPosition ──────────────────────────────────────────

  describe("getCursorPosition", () => {
    // I10 — F4: getCursorPosition is the PUSH delivery cursor; getReadCursor is the PULL read
    // cursor. They are SEPARATE columns. A pull read advances the read cursor only — the push
    // cursor stays put, so the push pump never skips a message a pull read consumed.
    it("push cursor is independent of pull reads; getReadCursor tracks the pull read", () => {
      const { svc } = setup();

      svc.register("alice");
      svc.register("bob");
      svc.createChannel("alice", "general");
      svc.subscribe("alice", "general");
      svc.subscribe("bob", "general");

      const msg = svc.send("bob", "general", "hello");

      // A pull read advances the READ cursor, NOT the push delivery cursor.
      svc.read("alice", "general");
      expect(svc.getReadCursor("alice", "general")).toBe(msg.id);
      expect(svc.getCursorPosition("alice", "general")).toBe(0);

      // advanceCursor (the push ACK) is what getCursorPosition reflects — independently.
      svc.advanceCursor("alice", "general", msg.id);
      expect(svc.getCursorPosition("alice", "general")).toBe(msg.id);
    });

    it("returns 0 for non-existent cursor (both push and pull)", () => {
      const { svc } = setup();
      expect(svc.getCursorPosition("nobody", "nonexistent")).toBe(0);
      expect(svc.getReadCursor("nobody", "nonexistent")).toBe(0);
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

  // I1 — Gap#1: per-ACK cursor advance. The SQLite PubSub pump() calls this once
  // per ACKed message (single-step), holding on NACK (head-of-line).
  describe("advanceCursor (I1 — per-ACK advance)", () => {
    it("advances the agent's cursor by exactly the acked message id (single-step)", () => {
      const { svc } = setup();
      svc.register("alice");
      svc.createChannel("alice", "general");
      svc.subscribe("alice", "general");
      svc.register("bob");
      svc.subscribe("bob", "general");
      const m1 = svc.send("bob", "general", "one");
      const m2 = svc.send("bob", "general", "two");

      expect(svc.getCursorPosition("alice", "general")).toBe(0);
      svc.advanceCursor("alice", "general", m1.id);
      expect(svc.getCursorPosition("alice", "general")).toBe(m1.id);
      // ACKing the next message advances exactly one more step (not a batch).
      svc.advanceCursor("alice", "general", m2.id);
      expect(svc.getCursorPosition("alice", "general")).toBe(m2.id);
    });

    it("is a no-op for an unknown channel (does not throw)", () => {
      const { svc } = setup();
      svc.register("alice");
      expect(() => svc.advanceCursor("alice", "nonexistent", 5)).not.toThrow();
      expect(svc.getCursorPosition("alice", "nonexistent")).toBe(0);
    });
  });

  // I3 — Gap#3: replayMessages — stateless forward read backing the SQLite adapter's
  // replayFrom. Strictly after sinceId, includes all authors (no self-exclude), no cursor advance.
  describe("replayMessages (I3)", () => {
    it("replays strictly after sinceId including all authors, advancing no cursor", () => {
      const { svc } = setup();
      svc.register("alice");
      svc.createChannel("alice", "general");
      svc.subscribe("alice", "general");
      svc.register("bob");
      svc.subscribe("bob", "general");
      const m1 = svc.send("alice", "general", "a1");
      const m2 = svc.send("bob", "general", "b1");
      const m3 = svc.send("alice", "general", "a2");

      const out = svc.replayMessages("alice", "general", m1.id, 50);
      expect(out.map((m) => m.id)).toEqual([m2.id, m3.id]);
      // alice's own m3 is present — replay does not self-exclude.
      expect(out.some((m) => m.agent_id === "alice")).toBe(true);

      // No cursor mutation.
      const before = svc.getCursorPosition("alice", "general");
      svc.replayMessages("alice", "general", 0, 50);
      expect(svc.getCursorPosition("alice", "general")).toBe(before);
    });

    it("returns empty for an unknown channel", () => {
      const { svc } = setup();
      svc.register("alice");
      expect(svc.replayMessages("alice", "nonexistent", 0, 50)).toEqual([]);
    });
  });

  // R2 — F3: replayMessages must gate like read() (single source of truth for "can this agent
  // read this channel"). A forgeable opaque cursor + an unwired seam meant a registered NON-member
  // could replay a private DM's full history once the SQLite adapter is the delivery surface.
  describe("replayMessages authz (R2/F3 — mirror read()'s gate)", () => {
    it("rejects a registered NON-member replaying a channel", () => {
      const { svc } = setup();
      svc.register("alice");
      svc.createChannel("alice", "general");
      svc.subscribe("alice", "general");
      svc.send("alice", "general", "a1");
      svc.register("charlie"); // registered, never joined "general"
      expect(() => svc.replayMessages("charlie", "general", 0, 50)).toThrow(
        'Not a member of channel "general"'
      );
    });

    it("rejects a registered NON-participant replaying a DM", () => {
      const { svc } = setup();
      svc.register("alice");
      svc.register("bob");
      svc.register("eve");
      svc.directMessage("alice", "bob", "secret");
      expect(() => svc.replayMessages("eve", "alice,bob", 0, 50)).toThrow(
        'DM channel "alice,bob" is private to alice and bob'
      );
    });

    it("allows a member / DM participant to replay the expected messages", () => {
      const { svc } = setup();
      svc.register("alice");
      svc.register("bob");
      const m = svc.directMessage("alice", "bob", "hello bob");
      const out = svc.replayMessages("bob", "alice,bob", 0, 50);
      expect(out.map((x) => x.content)).toEqual(["hello bob"]);
      expect(out[0]!.id).toBe(m.id);
    });

    it("requires registration before replay", () => {
      const { svc } = setup();
      svc.register("alice");
      svc.createChannel("alice", "general");
      expect(() => svc.replayMessages("ghost", "general", 0, 50)).toThrow(
        "must call messaging_register"
      );
    });
  });

  // I2 — Gap#2: subscribed membership flag + ghost-leak fix. Assert membership via
  // PRESENCE/ABSENCE (the projected `active` is LIVENESS, not membership).
  describe("unsubscribe / subscribed membership (I2)", () => {
    it("an unsubscribed agent vanishes from members, count, and the pull-drain", () => {
      const { svc } = setup();
      svc.register("alice");
      svc.createChannel("alice", "general");
      svc.subscribe("alice", "general");
      svc.register("bob");
      svc.subscribe("bob", "general");
      svc.send("alice", "general", "hello");

      expect(svc.listMembers("general").map((m) => m.agent_id).sort()).toEqual([
        "alice",
        "bob",
      ]);

      svc.unsubscribe("bob", "general");

      expect(svc.listMembers("general").map((m) => m.agent_id)).toEqual(["alice"]);
      // readAllUnread drains via listForAgent — the unsubscribed channel must not appear.
      expect(svc.readAllUnread("bob").find((u) => u.channel === "general")).toBeUndefined();
    });

    it("re-subscribe restores membership and resumes from the held position", () => {
      const { svc } = setup();
      svc.register("alice");
      svc.createChannel("alice", "general");
      svc.subscribe("alice", "general");
      svc.register("bob");
      svc.subscribe("bob", "general");
      const m1 = svc.send("alice", "general", "one");
      svc.advanceCursor("bob", "general", m1.id);
      svc.unsubscribe("bob", "general");
      svc.send("alice", "general", "two");

      svc.subscribe("bob", "general");
      // Position preserved (resumes from m1, NOT reset to a full-backlog 0).
      expect(svc.getCursorPosition("bob", "general")).toBe(m1.id);
      expect(svc.listMembers("general").map((m) => m.agent_id).sort()).toEqual([
        "alice",
        "bob",
      ]);
    });

    it("sending does NOT reactivate a previously-unsubscribed agent (RULED)", () => {
      const { svc } = setup();
      svc.register("alice");
      svc.createChannel("alice", "general");
      svc.subscribe("alice", "general");
      svc.register("bob");
      svc.subscribe("bob", "general");
      svc.unsubscribe("bob", "general");
      expect(svc.listMembers("general").map((m) => m.agent_id)).toEqual(["alice"]);

      // bob posts while unsubscribed — stays subscribed=0 (sender upsert is DO NOTHING).
      svc.send("bob", "general", "still here");
      expect(svc.listMembers("general").map((m) => m.agent_id)).toEqual(["alice"]);
    });
  });
});
