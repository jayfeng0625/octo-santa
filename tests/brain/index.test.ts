import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { FsBrainStore } from "../../src/storage/fs-brain-store/store";
import { createTmpDirTracker } from "../helpers/tmpdir";

const tmpDirs = createTmpDirTracker("index");
const makeTmpDir = tmpDirs.make.bind(tmpDirs);

afterEach(() => { tmpDirs.cleanup(); });

function writeBrainDoc(brainDir: string, filename: string, content: string): void {
  mkdirSync(brainDir, { recursive: true });
  writeFileSync(join(brainDir, filename), content);
}

const WEBHOOK_DOC = `---
title: Webhook Schemas
summary: Payload formats for all outbound webhooks
tags: [webhooks, events]
---

# Webhook Schemas
Full content here.
`;

const AUTH_DOC = `---
title: Auth Flows
summary: Authentication and authorization patterns
tags: [auth, security]
---

# Auth Flows
Details here.
`;

const PLAIN_DOC = `# Just a plain markdown file
No frontmatter at all.
`;

describe("scanBrainDocs", () => {
  it("scans dir and returns docs with correct slug, path, title, summary, tags", () => {
    const tmpDir = makeTmpDir();
    const brainDir = join(tmpDir, "brain");
    writeBrainDoc(brainDir, "webhook-schemas.md", WEBHOOK_DOC);

    const store = new FsBrainStore(tmpDir, ["brain"]);
    const docs = store.scanDocs();
    expect(docs).toHaveLength(1);
    expect(docs[0]!.slug).toBe("webhook-schemas");
    expect(docs[0]!.title).toBe("Webhook Schemas");
    expect(docs[0]!.summary).toBe("Payload formats for all outbound webhooks");
    expect(docs[0]!.tags).toEqual(["webhooks", "events"]);
    expect(docs[0]!.path).toContain("webhook-schemas.md");
  });

  it("includes files without frontmatter using derived defaults", () => {
    const tmpDir = makeTmpDir();
    const brainDir = join(tmpDir, "brain");
    writeBrainDoc(brainDir, "no-frontmatter.md", PLAIN_DOC);
    writeBrainDoc(brainDir, "webhook-schemas.md", WEBHOOK_DOC);

    const store = new FsBrainStore(tmpDir, ["brain"]);
    const docs = store.scanDocs();
    expect(docs).toHaveLength(2);
    const plain = docs.find(d => d.slug === "no-frontmatter");
    expect(plain).toBeDefined();
    expect(plain!.title).toBe("no-frontmatter");
    expect(plain!.summary).toBe("");
    expect(plain!.tags).toEqual([]);
  });

  it("handles missing brain dir gracefully (returns empty array)", () => {
    const tmpDir = makeTmpDir();
    // Don't create the brain dir at all
    const store = new FsBrainStore(tmpDir, ["brain"]);
    const docs = store.scanDocs();
    expect(docs).toEqual([]);
  });

  it("scans multiple dirs and returns all docs", () => {
    const tmpDir = makeTmpDir();
    const brainDir1 = join(tmpDir, "brain");
    const brainDir2 = join(tmpDir, "knowledge");
    writeBrainDoc(brainDir1, "webhook-schemas.md", WEBHOOK_DOC);
    writeBrainDoc(brainDir2, "auth-flows.md", AUTH_DOC);

    const store = new FsBrainStore(tmpDir, ["brain", "knowledge"]);
    const docs = store.scanDocs();
    expect(docs).toHaveLength(2);
    const slugs = docs.map(d => d.slug).sort();
    expect(slugs).toEqual(["auth-flows", "webhook-schemas"]);
  });

  it("returns empty array when dirs list is empty", () => {
    const tmpDir = makeTmpDir();
    const store = new FsBrainStore(tmpDir, []);
    const docs = store.scanDocs();
    expect(docs).toEqual([]);
  });

  it("produces normalized path for 'brain' dir", () => {
    const tmpDir = makeTmpDir();
    writeBrainDoc(join(tmpDir, "brain"), "doc.md", `---\ntitle: T\nsummary: S\ntags: []\n---\n`);
    const store = new FsBrainStore(tmpDir, ["brain"]);
    const docs = store.scanDocs();
    expect(docs[0]!.path).toBe("./brain/doc.md");
  });

  it("produces normalized path for './brain' dir", () => {
    const tmpDir = makeTmpDir();
    writeBrainDoc(join(tmpDir, "brain"), "doc.md", `---\ntitle: T\nsummary: S\ntags: []\n---\n`);
    const store = new FsBrainStore(tmpDir, ["./brain"]);
    const docs = store.scanDocs();
    expect(docs[0]!.path).toBe("./brain/doc.md");
  });

  it("produces normalized path for 'brain/' dir (trailing slash)", () => {
    const tmpDir = makeTmpDir();
    writeBrainDoc(join(tmpDir, "brain"), "doc.md", `---\ntitle: T\nsummary: S\ntags: []\n---\n`);
    const store = new FsBrainStore(tmpDir, ["brain/"]);
    const docs = store.scanDocs();
    expect(docs[0]!.path).toBe("./brain/doc.md");
  });

  it("produces normalized path for './brain/' dir", () => {
    const tmpDir = makeTmpDir();
    writeBrainDoc(join(tmpDir, "brain"), "doc.md", `---\ntitle: T\nsummary: S\ntags: []\n---\n`);
    const store = new FsBrainStore(tmpDir, ["./brain/"]);
    const docs = store.scanDocs();
    expect(docs[0]!.path).toBe("./brain/doc.md");
  });

  it("sorts docs alphabetically within a dir", () => {
    const tmpDir = makeTmpDir();
    const brainDir = join(tmpDir, "brain");
    writeBrainDoc(brainDir, "z-last.md", `---\ntitle: Z Last\nsummary: last\ntags: []\n---\n`);
    writeBrainDoc(brainDir, "a-first.md", `---\ntitle: A First\nsummary: first\ntags: []\n---\n`);

    const store = new FsBrainStore(tmpDir, ["brain"]);
    const docs = store.scanDocs();
    expect(docs).toHaveLength(2);
    expect(docs[0]!.slug).toBe("a-first");
    expect(docs[1]!.slug).toBe("z-last");
  });
});

describe("readBrainDoc", () => {
  it("returns full file content for a valid slug", () => {
    const tmpDir = makeTmpDir();
    const brainDir = join(tmpDir, "brain");
    writeBrainDoc(brainDir, "webhook-schemas.md", WEBHOOK_DOC);

    const store = new FsBrainStore(tmpDir, ["brain"]);
    const content = store.readDoc("webhook-schemas");
    expect(content).toBe(WEBHOOK_DOC);
  });

  it("throws for unknown slug", () => {
    const tmpDir = makeTmpDir();
    const brainDir = join(tmpDir, "brain");
    writeBrainDoc(brainDir, "webhook-schemas.md", WEBHOOK_DOC);

    const store = new FsBrainStore(tmpDir, ["brain"]);
    expect(() => store.readDoc("nonexistent")).toThrow("not found");
  });

  it("searches across multiple dirs and finds doc in second dir", () => {
    const tmpDir = makeTmpDir();
    const brainDir1 = join(tmpDir, "brain");
    const brainDir2 = join(tmpDir, "knowledge");
    writeBrainDoc(brainDir1, "webhook-schemas.md", WEBHOOK_DOC);
    writeBrainDoc(brainDir2, "auth-flows.md", AUTH_DOC);

    const store = new FsBrainStore(tmpDir, ["brain", "knowledge"]);
    const content = store.readDoc("auth-flows");
    expect(content).toBe(AUTH_DOC);
  });

  it("returns content from first matching dir when slug exists in both", () => {
    const tmpDir = makeTmpDir();
    const brainDir1 = join(tmpDir, "brain");
    const brainDir2 = join(tmpDir, "knowledge");
    writeBrainDoc(brainDir1, "shared.md", "first dir content");
    writeBrainDoc(brainDir2, "shared.md", "second dir content");

    const store = new FsBrainStore(tmpDir, ["brain", "knowledge"]);
    const content = store.readDoc("shared");
    expect(content).toBe("first dir content");
  });

  it("throws for empty dirs list", () => {
    const tmpDir = makeTmpDir();
    const store = new FsBrainStore(tmpDir, []);
    expect(() => store.readDoc("any-slug")).toThrow("not found");
  });
});
