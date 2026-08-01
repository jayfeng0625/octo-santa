import { describe, it, expect } from "bun:test";
import { validateAgentName, extractMentions } from "../../src/core/utils";

describe("validateAgentName", () => {
  it("accepts valid names", () => {
    expect(() => validateAgentName("code-reviewer")).not.toThrow();
    expect(() => validateAgentName("agent_1")).not.toThrow();
    expect(() => validateAgentName("backend-api")).not.toThrow();
  });

  it("rejects empty names", () => {
    expect(() => validateAgentName("")).toThrow("agent_id must not be empty");
  });

  it("rejects names with invalid characters", () => {
    expect(() => validateAgentName("agent name")).toThrow("must match");
    expect(() => validateAgentName("agent.name")).toThrow("must match");
    expect(() => validateAgentName("agent@name")).toThrow("must match");
  });
  it("rejects reserved names 'all' and 'here'", () => {
    expect(() => validateAgentName("all")).toThrow("reserved");
    expect(() => validateAgentName("here")).toThrow("reserved");
  });
});

describe("extractMentions", () => {
  it("extracts agent mentions", () => {
    expect(extractMentions("hey @code-reviewer check this", ["code-reviewer", "frontend"]))
      .toEqual(["code-reviewer"]);
  });

  it("extracts multiple mentions", () => {
    expect(extractMentions("@alice and @bob please review", ["alice", "bob", "charlie"]))
      .toEqual(["alice", "bob"]);
  });

  it("returns ['*'] for @all", () => {
    expect(extractMentions("@all heads up, deploying", ["alice"]))
      .toEqual(["*"]);
  });

  it("returns ['*'] for @here", () => {
    expect(extractMentions("@here deploying now", ["alice"]))
      .toEqual(["*"]);
  });

  it("drops invalid mentions silently", () => {
    expect(extractMentions("hey @nonexistent check this", ["alice"]))
      .toEqual([]);
  });

  it("returns empty array when no mentions", () => {
    expect(extractMentions("just a normal message", ["alice"]))
      .toEqual([]);
  });

  it("deduplicates mentions", () => {
    expect(extractMentions("@alice and @alice again", ["alice"]))
      .toEqual(["alice"]);
  });

  it("@all takes precedence over individual mentions", () => {
    expect(extractMentions("@alice @all check this", ["alice"]))
      .toEqual(["*"]);
  });
});

describe("extractMentions — unknown names", () => {
  it("ignores mentions that match no registered agent", () => {
    expect(
      extractMentions("hey @os-dev check this", ["os-dev-1"])
    ).toEqual([]);
  });
});
