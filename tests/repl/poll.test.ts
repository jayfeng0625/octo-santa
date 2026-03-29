import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { createDb } from "../../src/db";
import { runMigrations } from "../../src/migrations";
import {
  messagingMigrations,
  sendMessage,
} from "../../src/modules/messaging/tools";
import { pollTick, type PollState } from "../../src/repl/poll";
import { formatMessage } from "../../src/repl/display";

const TEST_DB = "/tmp/octo-santa-test-poll.sqlite";

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = path + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
}

function setupDb() {
  cleanupDb(TEST_DB);
  const db = createDb(TEST_DB);
  runMigrations(db, messagingMigrations);
  return db;
}

afterEach(() => cleanupDb(TEST_DB));

describe("pollTick", () => {
  it("returns new messages from subscribed channels", () => {
    const db = setupDb();

    sendMessage(db, "agent-a", "planning", "hey jay");

    const state: PollState = {
      activeChannel: "planning",
      cursors: new Map([["planning", 0]]),
    };
    const msgs = pollTick(db, "jay", state);

    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.agent).toBe("agent-a");
    expect(msgs[0]!.content).toBe("hey jay");
    expect(msgs[0]!.channel).toBe("planning");
    db.close();
  });

  it("returns messages from multiple channels with correct metadata", () => {
    const db = setupDb();

    sendMessage(db, "agent-a", "planning", "plan msg");
    sendMessage(db, "agent-b", "ops", "ops msg");

    const state: PollState = {
      activeChannel: "planning",
      cursors: new Map([
        ["planning", 0],
        ["ops", 0],
      ]),
    };
    const msgs = pollTick(db, "jay", state);

    expect(msgs).toHaveLength(2);

    const planMsg = msgs.find((m) => m.channel === "planning")!;
    expect(planMsg.agent).toBe("agent-a");
    expect(planMsg.content).toBe("plan msg");

    const opsMsg = msgs.find((m) => m.channel === "ops")!;
    expect(opsMsg.agent).toBe("agent-b");
    expect(opsMsg.content).toBe("ops msg");

    // Verify formatMessage still produces expected output
    expect(
      formatMessage(
        { agent_id: planMsg.agent, content: planMsg.content },
        planMsg.channel,
        state.activeChannel
      )
    ).toBe("[agent-a] plan msg");
    expect(
      formatMessage(
        { agent_id: opsMsg.agent, content: opsMsg.content },
        opsMsg.channel,
        state.activeChannel
      )
    ).toBe("[#ops][agent-b] ops msg");

    db.close();
  });

  it("advances cursor so same messages are not shown twice", () => {
    const db = setupDb();
    sendMessage(db, "agent-a", "planning", "first");

    const state: PollState = {
      activeChannel: "planning",
      cursors: new Map([["planning", 0]]),
    };

    const msgs1 = pollTick(db, "jay", state);
    expect(msgs1).toHaveLength(1);

    const msgs2 = pollTick(db, "jay", state);
    expect(msgs2).toHaveLength(0);
    db.close();
  });
});
