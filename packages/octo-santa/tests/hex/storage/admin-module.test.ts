import { describe, it, expect, afterEach } from "bun:test";
import { cleanupDb, testDbPath, setupTestDb } from "../../helpers/db";
import { allMigrations } from "../../../src/storage/sqlite/migrations";
import { SqliteAdminModule } from "../../../src/storage/sqlite/admin-module";

const TEST_DB = testDbPath("admin-module");

afterEach(() => {
  cleanupDb(TEST_DB);
});

function setup() {
  const db = setupTestDb(TEST_DB, allMigrations);
  const module = new SqliteAdminModule(db);
  return { db, module, api: module.createApi() };
}

const READ_METHODS = [
  "listAgents",
  "getAgent",
  "listChannels",
  "getChannel",
  "listMembers",
  "getMessages",
  "countMessages",
  "getLatestMessageId",
];
const WRITE_METHODS = [
  "createAgentIfMissing",
  "createChannelIfMissing",
  "addMember",
  "sendMessage",
  "sendDirectMessage",
];

describe("API surface", () => {
  it("exposes exactly the controlled methods — no raw SQL, no internals", () => {
    const { db, api } = setup();
    expect(Object.keys(api).sort()).toEqual(
      [...READ_METHODS, ...WRITE_METHODS].sort()
    );
    db.close();
  });

  // Drift guard, both directions: the served .d.ts and the runtime API must
  // declare exactly the same method sets, so neither a new method nor a
  // removed one can slip through undocumented.
  it("typehead declares exactly the methods the API implements", () => {
    const { db, module, api } = setup();
    const { globalName, provider, typehead } = module.describe();
    expect(globalName).toBe("storage");
    expect(provider).toBe("sqlite");
    expect(typehead).toContain("declare const storage: StorageApi");

    const declared = new Set(
      [...typehead.matchAll(/^\s{2}(\w+)\(/gm)].map((m) => m[1]!)
    );
    expect([...declared].sort()).toEqual(Object.keys(api).sort());
    db.close();
  });
});

describe("write surface", () => {
  it("createAgentIfMissing registers an external app idempotently", () => {
    const { db, api } = setup();
    const first = api.createAgentIfMissing("linear-hook");
    const second = api.createAgentIfMissing("linear-hook");
    expect(first.id).toBe("linear-hook");
    expect(first.active).toBe(false);
    expect(second.created_at).toBe(first.created_at);
    db.close();
  });

  it("createAgentIfMissing enforces agent-name rules", () => {
    const { db, api } = setup();
    expect(() => api.createAgentIfMissing("bad name!")).toThrow();
    expect(() => api.createAgentIfMissing("_system")).toThrow();
    db.close();
  });

  it("createChannelIfMissing creates once, auto-joins the creator, and rejects DM-style names", () => {
    const { db, api } = setup();
    const first = api.createChannelIfMissing("eng-triage", "linear-hook");
    const second = api.createChannelIfMissing("eng-triage", "someone-else");
    expect(second.id).toBe(first.id);
    expect(second.created_by).toBe("linear-hook");
    expect(api.listMembers("eng-triage").map((m) => m.agent_id)).toEqual([
      "linear-hook",
    ]);
    expect(() => api.createChannelIfMissing("alice,bob", "x")).toThrow("DM-style");
    db.close();
  });

  it("sendMessage delivers to an existing channel with explicit mentions", () => {
    const { db, api } = setup();
    api.createChannelIfMissing("eng-triage", "linear-hook");
    const message = api.sendMessage({
      channel: "eng-triage",
      sender: "linear-hook",
      content: "LIN-142 moved to In Review",
      mentions: ["*"],
    });
    expect(message.channel).toBe("eng-triage");
    expect(message.mentions).toEqual(["*"]);
    // The row landed with the mentions JSON the notification watcher filters on.
    const stored = db
      .query("SELECT mentions, agent_id FROM messages WHERE id = ?")
      .get(message.id) as { mentions: string; agent_id: string };
    expect(stored).toEqual({ mentions: '["*"]', agent_id: "linear-hook" });
    db.close();
  });

  it("sendMessage extracts mentions from content when not given explicitly", () => {
    const { db, api } = setup();
    api.createAgentIfMissing("planner");
    api.createChannelIfMissing("general", "bridge");
    const message = api.sendMessage({
      channel: "general",
      sender: "bridge",
      content: "heads up @planner and @nobody-known",
    });
    expect(message.mentions).toEqual(["planner"]);
    db.close();
  });

  it("sendMessage auto-registers the sender but requires the channel to exist", () => {
    const { db, api } = setup();
    expect(() =>
      api.sendMessage({ channel: "ghost", sender: "bridge", content: "x" })
    ).toThrow('Channel "ghost" does not exist');
    api.createChannelIfMissing("real", "creator");
    api.sendMessage({ channel: "real", sender: "fresh-sender", content: "x" });
    expect(api.getAgent("fresh-sender")).not.toBeNull();
    // Sender joined on send, mirroring messaging behavior.
    expect(api.listMembers("real").map((m) => m.agent_id)).toContain("fresh-sender");
    db.close();
  });

  it("sendMessage upholds messaging invariants: no self-mention, no empty content, DM privacy", () => {
    const { db, api } = setup();
    api.createChannelIfMissing("c", "bridge");
    expect(() =>
      api.sendMessage({ channel: "c", sender: "bridge", content: "hi", mentions: ["bridge"] })
    ).toThrow("Cannot @mention yourself");
    expect(() =>
      api.sendMessage({ channel: "c", sender: "bridge", content: "   " })
    ).toThrow("must not be empty");
    // A DM channel between two agents is private to them.
    api.createAgentIfMissing("alice");
    api.sendDirectMessage({ from: "bob", to: "alice", content: "hi" });
    expect(() =>
      api.sendMessage({ channel: "alice,bob", sender: "intruder", content: "x" })
    ).toThrow("private");
    db.close();
  });

  it("sendDirectMessage creates the DM channel, joins both parties, requires the target", () => {
    const { db, api } = setup();
    expect(() =>
      api.sendDirectMessage({ from: "bridge", to: "ghost", content: "x" })
    ).toThrow('Agent "ghost" not found');
    api.createAgentIfMissing("planner");
    const message = api.sendDirectMessage({
      from: "bridge",
      to: "planner",
      content: "direct ping",
    });
    expect(message.channel).toBe("bridge,planner");
    expect(api.listMembers("bridge,planner").map((m) => m.agent_id).sort()).toEqual([
      "bridge",
      "planner",
    ]);
    db.close();
  });

  it("addMember subscribes an agent and respects DM privacy", () => {
    const { db, api } = setup();
    api.createChannelIfMissing("open", "creator");
    api.addMember("open", "joiner");
    expect(api.listMembers("open").map((m) => m.agent_id)).toContain("joiner");
    api.createAgentIfMissing("alice");
    api.sendDirectMessage({ from: "bob", to: "alice", content: "hi" });
    expect(() => api.addMember("alice,bob", "intruder")).toThrow("private");
    db.close();
  });
});

describe("read surface", () => {
  function seed(api: ReturnType<SqliteAdminModule["createApi"]>) {
    api.createChannelIfMissing("triage", "bridge");
    api.createChannelIfMissing("random", "bridge");
    api.sendMessage({ channel: "triage", sender: "bridge", content: "one", mentions: ["*"] });
    api.sendMessage({ channel: "triage", sender: "bridge", content: "two" });
    api.createAgentIfMissing("planner");
    api.sendMessage({ channel: "random", sender: "planner", content: "three", mentions: ["bridge"] });
  }

  it("getMessages filters by channel, sender, mentioning, and after_id", () => {
    const { db, api } = setup();
    seed(api);
    expect(api.getMessages({ channel: "triage" }).map((m) => m.content)).toEqual([
      "one",
      "two",
    ]);
    expect(api.getMessages({ sender: "planner" }).map((m) => m.content)).toEqual([
      "three",
    ]);
    // mentioning matches direct mentions and @all broadcasts.
    expect(api.getMessages({ mentioning: "bridge" }).map((m) => m.content)).toEqual([
      "one",
      "three",
    ]);
    const first = api.getMessages({ limit: 1 })[0]!;
    expect(api.getMessages({ after_id: first.id }).map((m) => m.content)).toEqual([
      "two",
      "three",
    ]);
    db.close();
  });

  it("getMessages returns channel names and parsed mention arrays", () => {
    const { db, api } = setup();
    seed(api);
    const rows = api.getMessages({ channel: "random" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe("random");
    expect(rows[0]!.mentions).toEqual(["bridge"]);
    db.close();
  });

  it("countMessages aggregates with and without group_by", () => {
    const { db, api } = setup();
    seed(api);
    expect(api.countMessages()).toEqual([{ value: null, count: 3 }]);
    expect(api.countMessages({ group_by: "sender" })).toEqual([
      { value: "bridge", count: 2 },
      { value: "planner", count: 1 },
    ]);
    expect(api.countMessages({ group_by: "channel", channel: "triage" })).toEqual([
      { value: "triage", count: 2 },
    ]);
    const byDay = api.countMessages({ group_by: "day" });
    expect(byDay).toHaveLength(1);
    expect(byDay[0]!.count).toBe(3);
    expect(byDay[0]!.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    db.close();
  });

  it("getLatestMessageId tracks the high-water mark for incremental loops", () => {
    const { db, api } = setup();
    expect(api.getLatestMessageId()).toBe(0);
    seed(api);
    expect(api.getLatestMessageId()).toBe(3);
    db.close();
  });

  it("listMembers requires an existing channel", () => {
    const { db, api } = setup();
    expect(() => api.listMembers("nope")).toThrow('Channel "nope" does not exist');
    db.close();
  });
});
