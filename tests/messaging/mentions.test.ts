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

describe("extractMentions — profileBaseNames param", () => {
  it("recognizes a pool base name as a valid mention", () => {
    // "os-dev" is not in validAgentIds but IS a profile base name
    expect(
      extractMentions(
        "hey @os-dev check this",
        ["os-dev-1", "os-dev-2"],
        new Set(["os-dev"])
      )
    ).toEqual(["os-dev"]);
  });

  it("prefers direct agent ID over base name when both match", () => {
    // "os-dev-1" is both in validAgentIds and could be confused — but base names
    // are separate from agent IDs; here "os-dev" is the base name, "os-dev-1" is
    // the direct agent — if someone mentions @os-dev-1, it should be a direct mention
    expect(
      extractMentions(
        "hey @os-dev-1 check this",
        ["os-dev-1", "os-dev-2"],
        new Set(["os-dev"])
      )
    ).toEqual(["os-dev-1"]);
  });

  it("handles mixed mentions: base name and direct agent ID", () => {
    expect(
      extractMentions(
        "@os-dev and @os-dev-1 both see this",
        ["os-dev-1", "os-dev-2"],
        new Set(["os-dev"])
      )
    ).toEqual(["os-dev", "os-dev-1"]);
  });

  it("backward compat: works without profileBaseNames param (undefined)", () => {
    // Existing behavior unchanged when third param omitted
    expect(
      extractMentions("@alice check this", ["alice", "bob"])
    ).toEqual(["alice"]);
  });

  it("backward compat: profileBaseNames=undefined — base names not recognized", () => {
    expect(
      extractMentions(
        "hey @os-dev check this",
        ["os-dev-1"],
        undefined
      )
    ).toEqual([]);
  });
});
