import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scanBrainDocs, readBrainDoc } from "../../src/modules/brain/tools";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "octo-santa-test-index-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

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

    const docs = scanBrainDocs(tmpDir, ["brain"]);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.slug).toBe("webhook-schemas");
    expect(docs[0]!.title).toBe("Webhook Schemas");
    expect(docs[0]!.summary).toBe("Payload formats for all outbound webhooks");
    expect(docs[0]!.tags).toEqual(["webhooks", "events"]);
    expect(docs[0]!.path).toContain("webhook-schemas.md");
  });

  it("skips files without frontmatter", () => {
    const tmpDir = makeTmpDir();
    const brainDir = join(tmpDir, "brain");
    writeBrainDoc(brainDir, "no-frontmatter.md", PLAIN_DOC);
    writeBrainDoc(brainDir, "webhook-schemas.md", WEBHOOK_DOC);

    const docs = scanBrainDocs(tmpDir, ["brain"]);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.slug).toBe("webhook-schemas");
  });

  it("handles missing brain dir gracefully (returns empty array)", () => {
    const tmpDir = makeTmpDir();
    // Don't create the brain dir at all
    const docs = scanBrainDocs(tmpDir, ["brain"]);
    expect(docs).toEqual([]);
  });

  it("scans multiple dirs and returns all docs", () => {
    const tmpDir = makeTmpDir();
    const brainDir1 = join(tmpDir, "brain");
    const brainDir2 = join(tmpDir, "knowledge");
    writeBrainDoc(brainDir1, "webhook-schemas.md", WEBHOOK_DOC);
    writeBrainDoc(brainDir2, "auth-flows.md", AUTH_DOC);

    const docs = scanBrainDocs(tmpDir, ["brain", "knowledge"]);
    expect(docs).toHaveLength(2);
    const slugs = docs.map(d => d.slug).sort();
    expect(slugs).toEqual(["auth-flows", "webhook-schemas"]);
  });

  it("returns empty array when dirs list is empty", () => {
    const tmpDir = makeTmpDir();
    const docs = scanBrainDocs(tmpDir, []);
    expect(docs).toEqual([]);
  });

  it("produces normalized path for 'brain' dir", () => {
    const tmpDir = makeTmpDir();
    writeBrainDoc(join(tmpDir, "brain"), "doc.md", `---\ntitle: T\nsummary: S\ntags: []\n---\n`);
    const docs = scanBrainDocs(tmpDir, ["brain"]);
    expect(docs[0]!.path).toBe("./brain/doc.md");
  });

  it("produces normalized path for './brain' dir", () => {
    const tmpDir = makeTmpDir();
    writeBrainDoc(join(tmpDir, "brain"), "doc.md", `---\ntitle: T\nsummary: S\ntags: []\n---\n`);
    const docs = scanBrainDocs(tmpDir, ["./brain"]);
    expect(docs[0]!.path).toBe("./brain/doc.md");
  });

  it("produces normalized path for 'brain/' dir (trailing slash)", () => {
    const tmpDir = makeTmpDir();
    writeBrainDoc(join(tmpDir, "brain"), "doc.md", `---\ntitle: T\nsummary: S\ntags: []\n---\n`);
    const docs = scanBrainDocs(tmpDir, ["brain/"]);
    expect(docs[0]!.path).toBe("./brain/doc.md");
  });

  it("produces normalized path for './brain/' dir", () => {
    const tmpDir = makeTmpDir();
    writeBrainDoc(join(tmpDir, "brain"), "doc.md", `---\ntitle: T\nsummary: S\ntags: []\n---\n`);
    const docs = scanBrainDocs(tmpDir, ["./brain/"]);
    expect(docs[0]!.path).toBe("./brain/doc.md");
  });

  it("sorts docs alphabetically within a dir", () => {
    const tmpDir = makeTmpDir();
    const brainDir = join(tmpDir, "brain");
    writeBrainDoc(brainDir, "z-last.md", `---\ntitle: Z Last\nsummary: last\ntags: []\n---\n`);
    writeBrainDoc(brainDir, "a-first.md", `---\ntitle: A First\nsummary: first\ntags: []\n---\n`);

    const docs = scanBrainDocs(tmpDir, ["brain"]);
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

    const content = readBrainDoc(tmpDir, ["brain"], "webhook-schemas");
    expect(content).toBe(WEBHOOK_DOC);
  });

  it("throws for unknown slug", () => {
    const tmpDir = makeTmpDir();
    const brainDir = join(tmpDir, "brain");
    writeBrainDoc(brainDir, "webhook-schemas.md", WEBHOOK_DOC);

    expect(() => readBrainDoc(tmpDir, ["brain"], "nonexistent")).toThrow("not found");
  });

  it("searches across multiple dirs and finds doc in second dir", () => {
    const tmpDir = makeTmpDir();
    const brainDir1 = join(tmpDir, "brain");
    const brainDir2 = join(tmpDir, "knowledge");
    writeBrainDoc(brainDir1, "webhook-schemas.md", WEBHOOK_DOC);
    writeBrainDoc(brainDir2, "auth-flows.md", AUTH_DOC);

    const content = readBrainDoc(tmpDir, ["brain", "knowledge"], "auth-flows");
    expect(content).toBe(AUTH_DOC);
  });

  it("returns content from first matching dir when slug exists in both", () => {
    const tmpDir = makeTmpDir();
    const brainDir1 = join(tmpDir, "brain");
    const brainDir2 = join(tmpDir, "knowledge");
    writeBrainDoc(brainDir1, "shared.md", "first dir content");
    writeBrainDoc(brainDir2, "shared.md", "second dir content");

    const content = readBrainDoc(tmpDir, ["brain", "knowledge"], "shared");
    expect(content).toBe("first dir content");
  });

  it("throws for empty dirs list", () => {
    const tmpDir = makeTmpDir();
    expect(() => readBrainDoc(tmpDir, [], "any-slug")).toThrow("not found");
  });
});
