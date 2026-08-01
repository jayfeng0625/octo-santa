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
  return { db, module, search: module.createSearchApi(), exec: module.createExecuteApi() };
}

const SEARCH_METHODS = [
  "listAgents",
  "getAgent",
  "listChannels",
  "getChannel",
  "listMembers",
  "getMessages",
  "countMessages",
  "getMaxMessageId",
];
const WRITE_METHODS = [
  "ensureAgent",
  "ensureChannel",
  "addMember",
  "postMessage",
  "postDirectMessage",
];

describe("API surface", () => {
  it("search API exposes exactly the read methods — no write methods, no raw SQL", () => {
    const { db, search } = setup();
    expect(Object.keys(search).sort()).toEqual([...SEARCH_METHODS].sort());
    db.close();
  });

  it("execute API exposes the read methods plus exactly the controlled writes", () => {
    const { db, exec } = setup();
    expect(Object.keys(exec).sort()).toEqual(
      [...SEARCH_METHODS, ...WRITE_METHODS].sort()
    );
    db.close();
  });

  it("typehead declares the storage binding and every API method (drift guard)", () => {
    const { db, module } = setup();
    const { module: name, provider, typehead } = module.describe();
    expect(name).toBe("storage");
    expect(provider).toBe("sqlite");
    expect(typehead).toContain("declare const storage: StorageExecuteApi");
    for (const method of [...SEARCH_METHODS, ...WRITE_METHODS]) {
      expect(typehead, `typehead declares ${method}`).toContain(`${method}(`);
    }
    db.close();
  });
});

describe("write surface", () => {
  it("ensureAgent registers an external app idempotently", () => {
    const { db, exec } = setup();
    const first = exec.ensureAgent("linear-hook");
    const second = exec.ensureAgent("linear-hook");
    expect(first.id).toBe("linear-hook");
    expect(first.active).toBe(false);
    expect(second.created_at).toBe(first.created_at);
    db.close();
  });

  it("ensureAgent enforces agent-name rules", () => {
    const { db, exec } = setup();
    expect(() => exec.ensureAgent("bad name!")).toThrow();
    expect(() => exec.ensureAgent("_system")).toThrow();
    db.close();
  });

  it("ensureChannel creates once, auto-joins the creator, and rejects DM-style names", () => {
    const { db, exec } = setup();
    const first = exec.ensureChannel("eng-triage", "linear-hook");
    const second = exec.ensureChannel("eng-triage", "someone-else");
    expect(second.id).toBe(first.id);
    expect(second.created_by).toBe("linear-hook");
    expect(exec.listMembers("eng-triage").map((m) => m.agent_id)).toEqual([
      "linear-hook",
    ]);
    expect(() => exec.ensureChannel("alice,bob", "x")).toThrow("DM-style");
    db.close();
  });

  it("postMessage delivers to an existing channel with explicit mentions", () => {
    const { db, exec } = setup();
    exec.ensureChannel("eng-triage", "linear-hook");
    const message = exec.postMessage({
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

  it("postMessage extracts mentions from content when not given explicitly", () => {
    const { db, exec } = setup();
    exec.ensureAgent("planner");
    exec.ensureChannel("general", "bridge");
    const message = exec.postMessage({
      channel: "general",
      sender: "bridge",
      content: "heads up @planner and @nobody-known",
    });
    expect(message.mentions).toEqual(["planner"]);
    db.close();
  });

  it("postMessage auto-registers the sender but requires the channel to exist", () => {
    const { db, exec } = setup();
    expect(() =>
      exec.postMessage({ channel: "ghost", sender: "bridge", content: "x" })
    ).toThrow('Channel "ghost" does not exist');
    exec.ensureChannel("real", "creator");
    exec.postMessage({ channel: "real", sender: "fresh-sender", content: "x" });
    expect(exec.getAgent("fresh-sender")).not.toBeNull();
    // Sender joined on send, mirroring messaging behavior.
    expect(exec.listMembers("real").map((m) => m.agent_id)).toContain("fresh-sender");
    db.close();
  });

  it("postMessage upholds messaging invariants: no self-mention, no empty content, DM privacy", () => {
    const { db, exec } = setup();
    exec.ensureChannel("c", "bridge");
    expect(() =>
      exec.postMessage({ channel: "c", sender: "bridge", content: "hi", mentions: ["bridge"] })
    ).toThrow("Cannot @mention yourself");
    expect(() =>
      exec.postMessage({ channel: "c", sender: "bridge", content: "   " })
    ).toThrow("must not be empty");
    // A DM channel between two agents is private to them.
    exec.ensureAgent("alice");
    exec.postDirectMessage({ from: "bob", to: "alice", content: "hi" });
    expect(() =>
      exec.postMessage({ channel: "alice,bob", sender: "intruder", content: "x" })
    ).toThrow("private");
    db.close();
  });

  it("postDirectMessage creates the DM channel, joins both parties, requires the target", () => {
    const { db, exec } = setup();
    expect(() =>
      exec.postDirectMessage({ from: "bridge", to: "ghost", content: "x" })
    ).toThrow('Agent "ghost" not found');
    exec.ensureAgent("planner");
    const message = exec.postDirectMessage({
      from: "bridge",
      to: "planner",
      content: "direct ping",
    });
    expect(message.channel).toBe("bridge,planner");
    expect(exec.listMembers("bridge,planner").map((m) => m.agent_id).sort()).toEqual([
      "bridge",
      "planner",
    ]);
    db.close();
  });

  it("addMember subscribes an agent and respects DM privacy", () => {
    const { db, exec } = setup();
    exec.ensureChannel("open", "creator");
    exec.addMember("open", "joiner");
    expect(exec.listMembers("open").map((m) => m.agent_id)).toContain("joiner");
    exec.ensureAgent("alice");
    exec.postDirectMessage({ from: "bob", to: "alice", content: "hi" });
    expect(() => exec.addMember("alice,bob", "intruder")).toThrow("private");
    db.close();
  });
});

describe("read surface", () => {
  function seed(exec: ReturnType<SqliteAdminModule["createExecuteApi"]>) {
    exec.ensureChannel("triage", "bridge");
    exec.ensureChannel("random", "bridge");
    exec.postMessage({ channel: "triage", sender: "bridge", content: "one", mentions: ["*"] });
    exec.postMessage({ channel: "triage", sender: "bridge", content: "two" });
    exec.ensureAgent("planner");
    exec.postMessage({ channel: "random", sender: "planner", content: "three", mentions: ["bridge"] });
  }

  it("getMessages filters by channel, sender, mentioning, and afterId", () => {
    const { db, search, exec } = setup();
    seed(exec);
    expect(search.getMessages({ channel: "triage" }).map((m) => m.content)).toEqual([
      "one",
      "two",
    ]);
    expect(search.getMessages({ sender: "planner" }).map((m) => m.content)).toEqual([
      "three",
    ]);
    // mentioning matches direct mentions and @all broadcasts.
    expect(search.getMessages({ mentioning: "bridge" }).map((m) => m.content)).toEqual([
      "one",
      "three",
    ]);
    const first = search.getMessages({ limit: 1 })[0]!;
    expect(search.getMessages({ afterId: first.id }).map((m) => m.content)).toEqual([
      "two",
      "three",
    ]);
    db.close();
  });

  it("getMessages returns channel names and parsed mention arrays", () => {
    const { db, search, exec } = setup();
    seed(exec);
    const rows = search.getMessages({ channel: "random" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe("random");
    expect(rows[0]!.mentions).toEqual(["bridge"]);
    db.close();
  });

  it("countMessages aggregates with and without groupBy", () => {
    const { db, search, exec } = setup();
    seed(exec);
    expect(search.countMessages()).toEqual([{ group: null, count: 3 }]);
    expect(search.countMessages({ groupBy: "sender" })).toEqual([
      { group: "bridge", count: 2 },
      { group: "planner", count: 1 },
    ]);
    expect(search.countMessages({ groupBy: "channel", channel: "triage" })).toEqual([
      { group: "triage", count: 2 },
    ]);
    const byDay = search.countMessages({ groupBy: "day" });
    expect(byDay).toHaveLength(1);
    expect(byDay[0]!.count).toBe(3);
    expect(byDay[0]!.group).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    db.close();
  });

  it("getMaxMessageId tracks the high-water mark for incremental loops", () => {
    const { db, search, exec } = setup();
    expect(search.getMaxMessageId()).toBe(0);
    seed(exec);
    expect(search.getMaxMessageId()).toBe(3);
    db.close();
  });

  it("listMembers requires an existing channel", () => {
    const { db, search } = setup();
    expect(() => search.listMembers("nope")).toThrow('Channel "nope" does not exist');
    db.close();
  });
});
