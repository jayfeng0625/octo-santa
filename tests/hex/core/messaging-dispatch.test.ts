import { describe, it, expect, afterEach } from "bun:test";
import { MessagingService } from "../../../src/core/messaging/service";
import { createSqliteRepos } from "../../../src/storage/sqlite";
import { createDb } from "../../../src/storage/sqlite/db";
import {
  runMigrations,
  allMigrations,
} from "../../../src/storage/sqlite/migrations";
import { createNotificationDispatcher } from "../../../src/notifications/dispatch/dispatcher";
import { cleanupDb } from "../../helpers/db";

const TEST_DB = `/tmp/octo-santa-test-dispatch-${process.pid}.sqlite`;

function setup() {
  cleanupDb(TEST_DB);
  const db = createDb(TEST_DB);
  runMigrations(db, allMigrations);
  const repos = createSqliteRepos(db);
  const dispatcher = createNotificationDispatcher();
  const dispatched: {
    channelName: string;
    sender: string;
    content: string;
    messageId: number;
    isDm: boolean;
    targetAgents: string[];
  }[] = [];
  const origDispatch = dispatcher.dispatch.bind(dispatcher);
  dispatcher.dispatch = (notification) => {
    dispatched.push({ ...notification });
    origDispatch(notification);
  };
  const svc = new MessagingService(
    repos.agents,
    repos.channels,
    repos.messages,
    repos.cursors,
    process.pid,
    dispatcher
  );
  return { db, repos, svc, dispatcher, dispatched };
}

afterEach(() => cleanupDb(TEST_DB));

describe("MessagingService dispatch integration", () => {
  it("send() dispatches to mentioned subscriber", () => {
    const { svc, dispatched } = setup();
    svc.register("alice");
    svc.register("bob");
    svc.createChannel("alice", "general");
    svc.subscribe("alice", "general");
    svc.subscribe("bob", "general");

    svc.send("alice", "general", "hey @bob check this");

    expect(dispatched.length).toBe(1);
    expect(dispatched[0]!.targetAgents).toEqual(["bob"]);
    expect(dispatched[0]!.channelName).toBe("general");
    expect(dispatched[0]!.sender).toBe("alice");
    expect(dispatched[0]!.content).toBe("hey @bob check this");
    expect(dispatched[0]!.isDm).toBe(false);
  });

  it("send() does not dispatch when no mentions", () => {
    const { svc, dispatched } = setup();
    svc.register("alice");
    svc.register("bob");
    svc.createChannel("alice", "general");
    svc.subscribe("alice", "general");
    svc.subscribe("bob", "general");

    svc.send("alice", "general", "just a message");

    expect(dispatched.length).toBe(0);
  });

  it("send() dispatches @all to all subscribers except sender", () => {
    const { svc, dispatched } = setup();
    svc.register("alice");
    svc.register("bob");
    svc.register("charlie");
    svc.createChannel("alice", "general");
    svc.subscribe("alice", "general");
    svc.subscribe("bob", "general");
    svc.subscribe("charlie", "general");

    svc.send("alice", "general", "@all meeting now");

    expect(dispatched.length).toBe(1);
    expect(dispatched[0]!.targetAgents.sort()).toEqual(["bob", "charlie"]);
  });

  it("send() only dispatches to subscribed mentioned agents", () => {
    const { svc, dispatched } = setup();
    svc.register("alice");
    svc.register("bob");
    svc.register("charlie");
    svc.createChannel("alice", "general");
    svc.subscribe("alice", "general");
    svc.subscribe("bob", "general");
    // charlie is NOT subscribed

    svc.send("alice", "general", "@bob @charlie check this");

    expect(dispatched.length).toBe(1);
    // Only bob is subscribed — charlie should be filtered out
    expect(dispatched[0]!.targetAgents).toEqual(["bob"]);
  });

  it("send() does not include sender in @all targets", () => {
    const { svc, dispatched } = setup();
    svc.register("alice");
    svc.register("bob");
    svc.createChannel("alice", "general");
    svc.subscribe("alice", "general");
    svc.subscribe("bob", "general");

    svc.send("alice", "general", "@all hello");

    expect(dispatched[0]!.targetAgents).toEqual(["bob"]);
  });

  it("directMessage() dispatches to the other party as DM", () => {
    const { svc, dispatched } = setup();
    svc.register("alice");
    svc.register("bob");

    svc.directMessage("alice", "bob", "hey bob");

    expect(dispatched.length).toBe(1);
    expect(dispatched[0]!.targetAgents).toEqual(["bob"]);
    expect(dispatched[0]!.isDm).toBe(true);
    expect(dispatched[0]!.channelName).toBe("alice,bob");
  });

  it("directMessage() does not dispatch sender to self", () => {
    const { svc, dispatched } = setup();
    svc.register("alice");
    svc.register("bob");

    svc.directMessage("alice", "bob", "hey bob");

    expect(dispatched[0]!.targetAgents).not.toContain("alice");
  });

  it("send() on DM channel dispatches to other party without mention", () => {
    const { svc, dispatched } = setup();
    svc.register("alice");
    svc.register("bob");

    // Create DM channel via directMessage
    svc.directMessage("alice", "bob", "initial");
    dispatched.length = 0; // Clear first dispatch

    // Send follow-up without mention
    svc.send("alice", "alice,bob", "follow up, no mention");

    expect(dispatched.length).toBe(1);
    expect(dispatched[0]!.isDm).toBe(true);
    expect(dispatched[0]!.targetAgents).toEqual(["bob"]);
  });
});
