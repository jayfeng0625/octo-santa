import { describe, it, expect } from "bun:test";
import { createNotificationPoller } from "../../../src/notifications/poller/poller";
import type { NotificationPort, NotificationMeta } from "../../../src/core/ports";
import type { Message } from "../../../src/core/messaging/types";

type MessageWithChannel = Message & { channel_name: string };

function makeQueryFns(
  messages: MessageWithChannel[] = [],
  maxId = 0
) {
  return {
    getNewMessagesForAgent(_agentId: string, sinceId: number, limit: number) {
      return messages.filter((m) => m.id > sinceId).slice(0, limit);
    },
    getMaxMessageId() {
      return maxId;
    },
  };
}

function makeNotificationPort(): {
  port: NotificationPort;
  calls: { content: string; meta: NotificationMeta }[];
} {
  const calls: { content: string; meta: NotificationMeta }[] = [];
  const port: NotificationPort = {
    notify: async (content, meta) => {
      calls.push({ content, meta });
    },
  };
  return { port, calls };
}

function makeMessage(
  overrides: Partial<MessageWithChannel> & { id: number; channel_name: string }
): MessageWithChannel {
  return {
    channel_id: 1,
    agent_id: "agent-sender",
    content: "hello",
    created_at: Date.now(),
    mentions: "[]",
    ...overrides,
  };
}

describe("createNotificationPoller", () => {
  describe("HWM initialization", () => {
    it("initializes HWM from getMaxMessageId on start", async () => {
      const queryFns = makeQueryFns([], 42);
      const { port, calls } = makeNotificationPort();
      const poller = createNotificationPoller({
        ...queryFns,
        port,
        agentId: "agent-a",
      });

      poller.start();
      poller.stop();

      // No messages beyond id=42 exist, so no notifications should fire
      await poller._tick();
      expect(calls.length).toBe(0);
    });

    it("picks up messages with id > initial HWM", async () => {
      const msg = makeMessage({
        id: 10,
        channel_name: "agent-a,agent-b", // DM channel
        agent_id: "agent-b",
        content: "hi there",
      });

      const queryFns = makeQueryFns([msg], 5);
      const { port, calls } = makeNotificationPort();
      const poller = createNotificationPoller({
        ...queryFns,
        port,
        agentId: "agent-a",
      });

      poller.start();
      await poller._tick();
      poller.stop();

      expect(calls.length).toBe(1);
    });

    it("does not pick up messages at or below initial HWM", async () => {
      const msg = makeMessage({
        id: 10,
        channel_name: "agent-a,agent-b",
        agent_id: "agent-b",
        content: "old message",
      });

      // HWM starts at 10 — message at id=10 should be skipped
      const queryFns = makeQueryFns([msg], 10);
      const { port, calls } = makeNotificationPort();
      const poller = createNotificationPoller({
        ...queryFns,
        port,
        agentId: "agent-a",
      });

      poller.start();
      await poller._tick();
      poller.stop();

      expect(calls.length).toBe(0);
    });
  });

  describe("mention filtering", () => {
    it("notifies for DM channel messages regardless of mentions", async () => {
      // DM channels: two agent names joined by comma in alphabetical order
      const msg = makeMessage({
        id: 1,
        channel_name: "agent-a,agent-b",
        agent_id: "agent-b",
        content: "hey",
        mentions: "[]", // no mentions — but DM always notifies
      });

      const queryFns = makeQueryFns([msg], 0);
      const { port, calls } = makeNotificationPort();
      const poller = createNotificationPoller({
        ...queryFns,
        port,
        agentId: "agent-a",
      });

      poller.start();
      await poller._tick();
      poller.stop();

      expect(calls.length).toBe(1);
      expect(calls[0]!.content).toBe("hey");
    });

    it("notifies when agent is explicitly mentioned in a regular channel", async () => {
      const msg = makeMessage({
        id: 1,
        channel_name: "general",
        agent_id: "agent-b",
        content: "hello @agent-a",
        mentions: '["agent-a"]',
      });

      const queryFns = makeQueryFns([msg], 0);
      const { port, calls } = makeNotificationPort();
      const poller = createNotificationPoller({
        ...queryFns,
        port,
        agentId: "agent-a",
      });

      poller.start();
      await poller._tick();
      poller.stop();

      expect(calls.length).toBe(1);
    });

    it("notifies when wildcard mention (*) is used", async () => {
      const msg = makeMessage({
        id: 1,
        channel_name: "general",
        agent_id: "agent-b",
        content: "@all hello",
        mentions: '["*"]',
      });

      const queryFns = makeQueryFns([msg], 0);
      const { port, calls } = makeNotificationPort();
      const poller = createNotificationPoller({
        ...queryFns,
        port,
        agentId: "agent-a",
      });

      poller.start();
      await poller._tick();
      poller.stop();

      expect(calls.length).toBe(1);
    });

    it("skips silent messages in regular channels with no relevant mention", async () => {
      const msg = makeMessage({
        id: 1,
        channel_name: "general",
        agent_id: "agent-b",
        content: "hello @agent-c",
        mentions: '["agent-c"]',
      });

      const queryFns = makeQueryFns([msg], 0);
      const { port, calls } = makeNotificationPort();
      const poller = createNotificationPoller({
        ...queryFns,
        port,
        agentId: "agent-a", // agent-a is not mentioned
      });

      poller.start();
      await poller._tick();
      poller.stop();

      expect(calls.length).toBe(0);
    });

    it("skips messages with empty mentions in regular channels", async () => {
      const msg = makeMessage({
        id: 1,
        channel_name: "general",
        agent_id: "agent-b",
        content: "logging something",
        mentions: "[]",
      });

      const queryFns = makeQueryFns([msg], 0);
      const { port, calls } = makeNotificationPort();
      const poller = createNotificationPoller({
        ...queryFns,
        port,
        agentId: "agent-a",
      });

      poller.start();
      await poller._tick();
      poller.stop();

      expect(calls.length).toBe(0);
    });

    it("skips messages with malformed mentions JSON in regular channels", async () => {
      const msg = makeMessage({
        id: 1,
        channel_name: "general",
        agent_id: "agent-b",
        content: "broken mentions",
        mentions: "not-valid-json",
      });

      const queryFns = makeQueryFns([msg], 0);
      const { port, calls } = makeNotificationPort();
      const poller = createNotificationPoller({
        ...queryFns,
        port,
        agentId: "agent-a",
      });

      poller.start();
      await poller._tick();
      poller.stop();

      expect(calls.length).toBe(0);
    });
  });

  describe("HWM advancement", () => {
    it("advances HWM past all messages including skipped ones", async () => {
      const msgs: MessageWithChannel[] = [
        makeMessage({
          id: 1,
          channel_name: "general",
          agent_id: "agent-b",
          content: "skipped",
          mentions: "[]", // no mention — will be skipped
        }),
        makeMessage({
          id: 2,
          channel_name: "general",
          agent_id: "agent-b",
          content: "also skipped",
          mentions: "[]",
        }),
        makeMessage({
          id: 3,
          channel_name: "general",
          agent_id: "agent-b",
          content: "hello @agent-a",
          mentions: '["agent-a"]',
        }),
      ];

      const queryFns = makeQueryFns(msgs, 0);
      const { port, calls } = makeNotificationPort();
      const poller = createNotificationPoller({
        ...queryFns,
        port,
        agentId: "agent-a",
      });

      poller.start();
      await poller._tick();

      // Only the mention triggers a notify
      expect(calls.length).toBe(1);

      // Second tick should see no new messages (HWM should be 3 now)
      await poller._tick();
      expect(calls.length).toBe(1); // still 1 — nothing new

      poller.stop();
    });

    it("advances HWM incrementally across multiple ticks", async () => {
      let tick1Messages: MessageWithChannel[] = [
        makeMessage({
          id: 1,
          channel_name: "agent-a,agent-b",
          agent_id: "agent-b",
          content: "first",
        }),
      ];
      let tick2Messages: MessageWithChannel[] = [
        ...tick1Messages,
        makeMessage({
          id: 2,
          channel_name: "agent-a,agent-b",
          agent_id: "agent-b",
          content: "second",
        }),
      ];

      let allMessages = tick1Messages;

      const { port, calls } = makeNotificationPort();
      const poller = createNotificationPoller({
        getNewMessagesForAgent(_agentId: string, sinceId: number, limit: number) {
          return allMessages.filter((m) => m.id > sinceId).slice(0, limit);
        },
        getMaxMessageId() {
          return 0;
        },
        port,
        agentId: "agent-a",
      });

      poller.start();

      // First tick: picks up message id=1
      await poller._tick();
      expect(calls.length).toBe(1);

      // Add message id=2
      allMessages = tick2Messages;

      // Second tick: should only pick up message id=2 (HWM should be at 1)
      await poller._tick();
      expect(calls.length).toBe(2);

      poller.stop();
    });
  });

  describe("port.notify meta", () => {
    it("calls port.notify with correct content and meta keys", async () => {
      const msg = makeMessage({
        id: 7,
        channel_name: "general",
        agent_id: "agent-sender",
        content: "look at this @agent-a",
        mentions: '["agent-a"]',
      });

      const queryFns = makeQueryFns([msg], 0);
      const { port, calls } = makeNotificationPort();
      const poller = createNotificationPoller({
        ...queryFns,
        port,
        agentId: "agent-a",
      });

      poller.start();
      await poller._tick();
      poller.stop();

      expect(calls.length).toBe(1);
      expect(calls[0]!.content).toBe("look at this @agent-a");
      expect(calls[0]!.meta).toEqual({
        channel_name: "general",
        sender: "agent-sender",
        message_id: "7",
      });
    });
  });

  describe("start/stop lifecycle", () => {
    it("stop clears the interval and prevents further ticks", async () => {
      let tickCount = 0;

      const { port } = makeNotificationPort();
      const poller = createNotificationPoller({
        getNewMessagesForAgent() {
          tickCount++;
          return [];
        },
        getMaxMessageId() {
          return 0;
        },
        port,
        agentId: "agent-a",
        intervalMs: 10,
      });

      poller.start();
      await Bun.sleep(35); // allow ~3 ticks
      poller.stop();
      const countAtStop = tickCount;

      await Bun.sleep(30); // wait — should get no more ticks
      expect(tickCount).toBe(countAtStop);
    });

    it("fires on interval after start", async () => {
      let callCount = 0;

      const { port } = makeNotificationPort();
      const poller = createNotificationPoller({
        getNewMessagesForAgent() {
          callCount++;
          return [];
        },
        getMaxMessageId() {
          return 0;
        },
        port,
        agentId: "agent-a",
        intervalMs: 20,
      });

      poller.start();
      await Bun.sleep(70); // ~3 ticks at 20ms intervals
      poller.stop();

      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    it("stop is idempotent — calling stop twice does not throw", () => {
      const queryFns = makeQueryFns([], 0);
      const { port } = makeNotificationPort();
      const poller = createNotificationPoller({ ...queryFns, port, agentId: "agent-a" });

      poller.start();
      poller.stop();
      expect(() => poller.stop()).not.toThrow();
    });

    it("catches and continues on tick errors", async () => {
      let callCount = 0;

      const { port } = makeNotificationPort();
      const poller = createNotificationPoller({
        getNewMessagesForAgent() {
          callCount++;
          throw new Error("db exploded");
        },
        getMaxMessageId() {
          return 0;
        },
        port,
        agentId: "agent-a",
      });

      poller.start();

      // Direct tick calls should not throw
      await expect(poller._tick()).resolves.toBeUndefined();
      await expect(poller._tick()).resolves.toBeUndefined();
      expect(callCount).toBe(2);

      poller.stop();
    });
  });

  describe("channel activity signal", () => {
    function makeActivityPort(): {
      port: NotificationPort;
      notifyCalls: string[];
      activityCalls: string[];
    } {
      const notifyCalls: string[] = [];
      const activityCalls: string[] = [];
      const port: NotificationPort = {
        notify: async (content) => {
          notifyCalls.push(content);
        },
        notifyChannelActivity: async (channelName) => {
          activityCalls.push(channelName);
        },
      };
      return { port, notifyCalls, activityCalls };
    }

    it("fires for silent messages regardless of the mention filter", async () => {
      const msg = makeMessage({
        id: 1,
        channel_name: "general",
        agent_id: "agent-b",
        content: "no mention here",
        mentions: "[]",
      });

      const { port, notifyCalls, activityCalls } = makeActivityPort();
      const poller = createNotificationPoller({
        ...makeQueryFns([msg], 0),
        port,
        agentId: "agent-a",
      });

      poller.start();
      await poller._tick();
      poller.stop();

      expect(notifyCalls.length).toBe(0); // mention filter still applies to notify
      expect(activityCalls).toEqual(["general"]);
    });

    it("dedups to one signal per channel per tick", async () => {
      const msgs = [
        makeMessage({ id: 1, channel_name: "general", agent_id: "agent-b", content: "one" }),
        makeMessage({ id: 2, channel_name: "general", agent_id: "agent-b", content: "two" }),
        makeMessage({ id: 3, channel_name: "other", agent_id: "agent-b", content: "three" }),
      ];

      const { port, activityCalls } = makeActivityPort();
      const poller = createNotificationPoller({
        ...makeQueryFns(msgs, 0),
        port,
        agentId: "agent-a",
      });

      poller.start();
      await poller._tick();
      poller.stop();

      expect(activityCalls.sort()).toEqual(["general", "other"]);
    });

    it("does not re-signal already-consumed messages on the next tick", async () => {
      const msg = makeMessage({
        id: 1,
        channel_name: "general",
        agent_id: "agent-b",
        content: "once",
      });

      const { port, activityCalls } = makeActivityPort();
      const poller = createNotificationPoller({
        ...makeQueryFns([msg], 0),
        port,
        agentId: "agent-a",
      });

      poller.start();
      await poller._tick();
      await poller._tick();
      poller.stop();

      expect(activityCalls).toEqual(["general"]);
    });

    it("works with ports that do not implement notifyChannelActivity", async () => {
      const msg = makeMessage({
        id: 1,
        channel_name: "agent-a,agent-b",
        agent_id: "agent-b",
        content: "dm",
      });

      const { port, calls } = makeNotificationPort(); // no notifyChannelActivity
      const poller = createNotificationPoller({
        ...makeQueryFns([msg], 0),
        port,
        agentId: "agent-a",
      });

      poller.start();
      await expect(poller._tick()).resolves.toBeUndefined();
      poller.stop();
      expect(calls.length).toBe(1);
    });

    it("does not throw when notifyChannelActivity rejects", async () => {
      const msg = makeMessage({
        id: 1,
        channel_name: "general",
        agent_id: "agent-b",
        content: "boom",
      });

      const port: NotificationPort = {
        notify: async () => {},
        notifyChannelActivity: async () => {
          throw new Error("transport failure");
        },
      };

      const poller = createNotificationPoller({
        ...makeQueryFns([msg], 0),
        port,
        agentId: "agent-a",
      });

      poller.start();
      await expect(poller._tick()).resolves.toBeUndefined();
      poller.stop();
    });
  });

  describe("fire-and-forget notify errors", () => {
    it("does not throw when port.notify rejects", async () => {
      const msg = makeMessage({
        id: 1,
        channel_name: "agent-a,agent-b",
        agent_id: "agent-b",
        content: "boom",
      });

      const queryFns = makeQueryFns([msg], 0);
      const failingPort: NotificationPort = {
        notify: async () => {
          throw new Error("transport failure");
        },
      };

      const poller = createNotificationPoller({
        ...queryFns,
        port: failingPort,
        agentId: "agent-a",
      });

      poller.start();
      // Should not throw
      await expect(poller._tick()).resolves.toBeUndefined();
      poller.stop();
    });
  });
});
