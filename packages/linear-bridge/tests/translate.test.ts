import { describe, it, expect } from "bun:test";
import { translate } from "../src/translate";

const ISSUE_URL = "https://linear.app/acme/issue/ENG-123/fix-the-flux-capacitor";

function issueCreate(overrides: Record<string, unknown> = {}) {
  return {
    action: "create",
    type: "Issue",
    url: ISSUE_URL,
    createdAt: "2026-08-01T10:00:00.000Z",
    webhookTimestamp: 1_754_042_400_000,
    data: {
      id: "b3c1a9e0-0000-0000-0000-000000000000",
      identifier: "ENG-123",
      title: "Fix the flux capacitor",
      state: { id: "state-1", name: "Todo", type: "unstarted" },
    },
    ...overrides,
  };
}

describe("translate", () => {
  it("turns an issue create into a channel message mentioning everyone", () => {
    expect(translate(issueCreate())).toEqual({
      content: `Linear ENG-123 created: Fix the flux capacitor (Todo) ${ISSUE_URL}`,
      mentions: ["*"],
    });
  });

  it("turns an issue update with a state change into a status message", () => {
    const payload = issueCreate({
      action: "update",
      data: {
        identifier: "ENG-123",
        title: "Fix the flux capacitor",
        state: { id: "state-2", name: "In Review", type: "started" },
      },
      updatedFrom: { stateId: "state-1", updatedAt: "2026-08-01T09:00:00.000Z" },
    });
    const result = translate(payload);
    expect(result).toEqual({
      content: `Linear ENG-123 moved to In Review: Fix the flux capacitor ${ISSUE_URL}`,
      mentions: ["*"],
    });
  });

  it("ignores issue updates that did not change state", () => {
    const payload = issueCreate({
      action: "update",
      updatedFrom: { title: "Old title", updatedAt: "2026-08-01T09:00:00.000Z" },
    });
    expect(translate(payload)).toBeNull();
  });

  it("ignores issue updates with no updatedFrom at all", () => {
    expect(translate(issueCreate({ action: "update" }))).toBeNull();
  });

  it("turns a comment create into an excerpted message", () => {
    const payload = {
      action: "create",
      type: "Comment",
      url: `${ISSUE_URL}#comment-abc`,
      data: {
        id: "comment-abc",
        body: "Looks good, but check the WAL checkpointing path first.",
        issueId: "b3c1a9e0-0000-0000-0000-000000000000",
        issue: { id: "b3c1a9e0-0000-0000-0000-000000000000", identifier: "ENG-123" },
      },
    };
    expect(translate(payload)).toEqual({
      content: `Comment on ENG-123: Looks good, but check the WAL checkpointing path first. ${ISSUE_URL}#comment-abc`,
      mentions: ["*"],
    });
  });

  it("truncates comment bodies to 200 characters", () => {
    const body = "x".repeat(500);
    const result = translate({
      action: "create",
      type: "Comment",
      data: { body, issue: { identifier: "ENG-9" } },
    });
    expect(result).not.toBeNull();
    expect(result!.content).toBe(`Comment on ENG-9: ${"x".repeat(200)}`);
  });

  it("falls back to issueId when the comment has no issue identifier", () => {
    const result = translate({
      action: "create",
      type: "Comment",
      data: { body: "hi", issueId: "uuid-1" },
    });
    expect(result!.content).toBe("Comment on uuid-1: hi");
  });

  it("ignores unknown types and actions", () => {
    expect(translate({ type: "Project", action: "create", data: {} })).toBeNull();
    expect(translate({ type: "Issue", action: "remove", data: {} })).toBeNull();
    expect(translate({ type: "Comment", action: "update", data: {} })).toBeNull();
  });

  it("ignores non-object payloads", () => {
    expect(translate(null)).toBeNull();
    expect(translate("Issue")).toBeNull();
    expect(translate(42)).toBeNull();
    expect(translate([1, 2, 3])).toBeNull();
  });

  it("handles an issue create with all optional fields missing", () => {
    const result = translate({ type: "Issue", action: "create" });
    expect(result).toEqual({
      content: "Linear issue created: (untitled) (unknown state)",
      mentions: ["*"],
    });
  });
});
