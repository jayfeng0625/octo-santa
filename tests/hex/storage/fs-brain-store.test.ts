import { describe, it, expect, afterEach } from "bun:test";
import { FsBrainStore } from "../../../src/storage/fs-brain-store/store";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";

const TMP_DIR = `/tmp/octo-santa-test-hex-brain-store-${process.pid}`;

function setup(opts: { dirs?: string[]; files?: string[] } = {}) {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  return new FsBrainStore(TMP_DIR, opts.dirs, opts.files);
}

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("FsBrainStore", () => {
  it("scanDocs returns docs with frontmatter from configured dirs", () => {
    const store = setup({ dirs: ["brain"] });
    const brainDir = join(TMP_DIR, "brain");
    mkdirSync(brainDir, { recursive: true });
    writeFileSync(join(brainDir, "test-doc.md"), "---\ntitle: Test Doc\nsummary: A test\ntags: [ts]\n---\nContent here.");
    const docs = store.scanDocs();
    expect(docs.length).toBe(1);
    expect(docs[0]!.slug).toBe("test-doc");
    expect(docs[0]!.title).toBe("Test Doc");
  });

  it("readDoc returns file contents", () => {
    const store = setup({ dirs: ["brain"] });
    const brainDir = join(TMP_DIR, "brain");
    mkdirSync(brainDir, { recursive: true });
    writeFileSync(join(brainDir, "test-doc.md"), "---\ntitle: Test\nsummary: A test\ntags: []\n---\nContent.");
    const content = store.readDoc("test-doc");
    expect(content).toContain("Content.");
  });

  it("readDoc throws for missing slug", () => {
    const store = setup({ dirs: ["brain"] });
    expect(() => store.readDoc("nonexistent")).toThrow("not found");
  });

  it("scanDocs returns empty for missing dirs", () => {
    const store = setup({ dirs: ["nonexistent"] });
    expect(store.scanDocs()).toEqual([]);
  });
});
