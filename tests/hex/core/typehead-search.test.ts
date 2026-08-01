import { describe, it, expect } from "bun:test";
import { TypeheadIndex } from "../../../src/core/admin/typehead-index";
import { STORAGE_TYPEHEAD } from "../../../src/storage/sqlite/admin-typehead";

// The discovery half of the admin API: chunking module-authored .d.ts
// fragments into searchable declarations. Exercised against both a minimal
// synthetic fragment and the real storage fragment, so the parser is proven
// on the exact document it serves in production.

const FRAGMENT = `\
// ── Module "demo" ──
// Overview: talks about widgets and delivery.

/** A widget on record. */
interface WidgetRecord {
  id: number;
  /** Human-readable label. */
  label: string;
}

interface DemoApi {
  /** List every widget currently stored. */
  listWidgets(): WidgetRecord[];
  /**
   * Ship a widget somewhere.
   * Multi-line doc with the word dispatch in it.
   */
  shipWidget(input: { id: number; to: string }): void;
}

declare const demo: DemoApi;
`;

function makeIndex() {
  return new TypeheadIndex([
    { globalName: "demo", provider: "test", typehead: FRAGMENT },
  ]);
}

describe("TypeheadIndex on a synthetic fragment", () => {
  it("chunks members with their docs and enclosing interface", () => {
    const found = makeIndex().search("ship widget", 10);
    expect(found.matches[0]!.name).toBe("shipWidget");
    expect(found.matches[0]!.declaration).toContain("member of DemoApi");
    expect(found.matches[0]!.declaration).toContain("Ship a widget somewhere.");
    expect(found.matches[0]!.declaration).toContain("shipWidget(input:");
  });

  it("matches doc-comment words, not just names", () => {
    const found = makeIndex().search("dispatch", 10);
    expect(found.matches.map((m) => m.name)).toContain("shipWidget");
  });

  it("indexes interfaces, the global declaration, and the overview", () => {
    const index = makeIndex();
    expect(index.search("widget record", 10).matches.map((m) => m.name)).toContain(
      "WidgetRecord"
    );
    expect(index.search("demo api", 10).matches.map((m) => m.name)).toContain("demo");
    const overview = index.search("overview delivery", 10);
    expect(overview.matches[0]!.name).toBe("demo");
    expect(overview.matches[0]!.declaration).toContain("talks about widgets");
  });

  it("ranks name matches above body matches", () => {
    // "label" is a member of WidgetRecord by name, and appears in docs too.
    const found = makeIndex().search("label", 10);
    expect(found.matches[0]!.name).toBe("label");
  });

  it("applies the limit and reports the pre-limit total", () => {
    const all = makeIndex().search("widget", 10);
    const capped = makeIndex().search("widget", 1);
    expect(capped.matches).toHaveLength(1);
    expect(capped.total).toBe(all.total);
    expect(all.total).toBeGreaterThan(1);
  });
});

describe("TypeheadIndex on the real storage fragment", () => {
  const index = new TypeheadIndex([
    { globalName: "storage", provider: "sqlite", typehead: STORAGE_TYPEHEAD },
  ]);

  it("an agent searching how to send finds sendMessage first, docs included", () => {
    const found = index.search("send message", 10);
    expect(found.matches[0]!.name).toBe("sendMessage");
    expect(found.matches[0]!.declaration).toContain("sendMessage(input: SendMessageInput)");
    expect(found.matches[0]!.declaration).toContain("This is how you reach agents");
  });

  it("finds the delivery-model overview for conceptual questions", () => {
    const found = index.search("how messages reach agents notified", 10);
    expect(found.matches.map((m) => m.name)).toContain("storage");
  });

  it("finds counting and incremental-pull methods by plain words", () => {
    expect(index.search("count messages", 5).matches[0]!.name).toBe("countMessages");
    expect(
      index.search("newest message id arrived since", 5).matches.map((m) => m.name)
    ).toContain("getLatestMessageId");
  });

  it("every StorageApi method is discoverable by its own name", () => {
    const methods = [
      "listAgents",
      "getAgent",
      "listChannels",
      "getChannel",
      "listMembers",
      "getMessages",
      "countMessages",
      "getLatestMessageId",
      "createAgentIfMissing",
      "createChannelIfMissing",
      "addMember",
      "sendMessage",
      "sendDirectMessage",
    ];
    for (const method of methods) {
      const found = index.search(method, 5);
      expect(found.matches.map((m) => m.name), `search("${method}")`).toContain(method);
    }
  });
});
