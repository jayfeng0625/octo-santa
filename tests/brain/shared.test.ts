import { describe, it, expect, afterAll, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, unlinkSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { FsBrainStore } from "../../src/storage/fs-brain-store/store";

const TMP_SHARED = `/tmp/octo-santa-test-shared-brain-${process.pid}`;
const SHARED_DIR = join(TMP_SHARED, "brain");
const TEST_FILE = join(SHARED_DIR, "test-shared-brain-doc.md");

const TEST_DOC_CONTENT = `---
title: Test Shared Doc
summary: A test document for shared brain
tags: [test, shared]
---

# Test Shared Doc
This is a test document for the shared brain.
`;

// Inject temp shared brain dir via constructor
const store = new FsBrainStore("/tmp", undefined, undefined, SHARED_DIR);

afterAll(() => {
  if (existsSync(TMP_SHARED)) rmSync(TMP_SHARED, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);
});

describe("scanSharedBrainDocs", () => {
  it("returns BrainDoc[] from shared dir after writing a test file", () => {
    mkdirSync(SHARED_DIR, { recursive: true });
    writeFileSync(TEST_FILE, TEST_DOC_CONTENT);

    const docs = store.scanSharedDocs();
    expect(Array.isArray(docs)).toBe(true);

    const testDoc = docs.find(d => d.slug === "test-shared-brain-doc");
    expect(testDoc).toBeDefined();
    expect(testDoc!.title).toBe("Test Shared Doc");
    expect(testDoc!.summary).toBe("A test document for shared brain");
    expect(testDoc!.tags).toEqual(["test", "shared"]);
    expect(testDoc!.path).toBe("~/.octo-santa/brain/test-shared-brain-doc.md");
  });

  it("does not require a .octo-santa/config.json (no config needed)", () => {
    mkdirSync(SHARED_DIR, { recursive: true });
    writeFileSync(TEST_FILE, TEST_DOC_CONTENT);

    expect(() => store.scanSharedDocs()).not.toThrow();
    const docs = store.scanSharedDocs();
    expect(Array.isArray(docs)).toBe(true);
  });

  it("returns empty array when shared dir does not exist", () => {
    if (existsSync(SHARED_DIR)) rmSync(SHARED_DIR, { recursive: true });
    const docs = store.scanSharedDocs();
    expect(docs).toEqual([]);
  });

  it("includes files without frontmatter using derived defaults", () => {
    mkdirSync(SHARED_DIR, { recursive: true });
    const plainFile = join(SHARED_DIR, "test-plain-no-frontmatter.md");
    writeFileSync(plainFile, "# Just a plain file\nNo frontmatter here.\n");
    writeFileSync(TEST_FILE, TEST_DOC_CONTENT);

    try {
      const docs = store.scanSharedDocs();
      const plainDoc = docs.find(d => d.slug === "test-plain-no-frontmatter");
      expect(plainDoc).toBeDefined();
      expect(plainDoc!.title).toBe("test-plain-no-frontmatter");
      expect(plainDoc!.summary).toBe("");
      expect(plainDoc!.tags).toEqual([]);
    } finally {
      if (existsSync(plainFile)) unlinkSync(plainFile);
    }
  });
});

describe("readSharedBrainDoc", () => {
  it("returns full content for a valid slug", () => {
    mkdirSync(SHARED_DIR, { recursive: true });
    writeFileSync(TEST_FILE, TEST_DOC_CONTENT);

    const content = store.readSharedDoc("test-shared-brain-doc");
    expect(content).toBe(TEST_DOC_CONTENT);
  });

  it("throws for nonexistent slug", () => {
    expect(() => store.readSharedDoc("nonexistent-slug-that-does-not-exist")).toThrow("not found");
  });

  it("works without any .octo-santa/config.json", () => {
    mkdirSync(SHARED_DIR, { recursive: true });
    writeFileSync(TEST_FILE, TEST_DOC_CONTENT);

    expect(() => store.readSharedDoc("test-shared-brain-doc")).not.toThrow();
  });
});
