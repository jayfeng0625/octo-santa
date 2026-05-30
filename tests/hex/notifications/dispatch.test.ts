import { describe, it, expect } from "bun:test";
import { createNotificationDispatcher } from "../../../src/notifications/dispatch/dispatcher";
import type { NotificationPort, NotificationMeta } from "../../../src/core/ports";

describe("createNotificationDispatcher", () => {
  function makePort() {
    const calls: { content: string; meta: NotificationMeta }[] = [];
    const port: NotificationPort = {
      notify: async (content, meta) => {
        calls.push({ content, meta });
      },
    };
    return { port, calls };
  }

  it("dispatches to registered handler", () => {
    const dispatcher = createNotificationDispatcher();
    const { port, calls } = makePort();
    dispatcher.register("agent-a", port);

    dispatcher.dispatch({
      channelName: "general",
      sender: "agent-b",
      content: "hello @agent-a",
      messageId: 1,
      isDm: false,
      targetAgents: ["agent-a"],
    });

    expect(calls.length).toBe(1);
    expect(calls[0]!.content).toBe("hello @agent-a");
    expect(calls[0]!.meta).toEqual({
      channel_name: "general",
      sender: "agent-b",
      message_id: "1",
    });
  });

  it("silently skips agents with no registered handler", () => {
    const dispatcher = createNotificationDispatcher();

    // Should not throw
    dispatcher.dispatch({
      channelName: "general",
      sender: "agent-b",
      content: "hello",
      messageId: 1,
      isDm: false,
      targetAgents: ["agent-a", "agent-c"],
    });
  });

  it("dispatches to multiple targets", () => {
    const dispatcher = createNotificationDispatcher();
    const portA = makePort();
    const portB = makePort();
    dispatcher.register("agent-a", portA.port);
    dispatcher.register("agent-b", portB.port);

    dispatcher.dispatch({
      channelName: "general",
      sender: "agent-c",
      content: "@all hello",
      messageId: 5,
      isDm: false,
      targetAgents: ["agent-a", "agent-b"],
    });

    expect(portA.calls.length).toBe(1);
    expect(portB.calls.length).toBe(1);
  });

  it("does not dispatch to unregistered handler after unregister", () => {
    const dispatcher = createNotificationDispatcher();
    const { port, calls } = makePort();
    dispatcher.register("agent-a", port);
    dispatcher.unregister("agent-a");

    dispatcher.dispatch({
      channelName: "general",
      sender: "agent-b",
      content: "hello",
      messageId: 1,
      isDm: false,
      targetAgents: ["agent-a"],
    });

    expect(calls.length).toBe(0);
  });

  it("catches and logs notify errors without throwing", () => {
    const dispatcher = createNotificationDispatcher();
    const failingPort: NotificationPort = {
      notify: async () => {
        throw new Error("transport failure");
      },
    };
    dispatcher.register("agent-a", failingPort);

    // Should not throw
    dispatcher.dispatch({
      channelName: "general",
      sender: "agent-b",
      content: "hello",
      messageId: 1,
      isDm: false,
      targetAgents: ["agent-a"],
    });
  });
});
