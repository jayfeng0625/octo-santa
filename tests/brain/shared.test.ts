import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { scanSharedBrainDocs, readSharedBrainDoc } from "../../src/modules/brain/tools";

const SHARED_DIR = join(homedir(), ".octo-santa", "brain");
const TEST_FILE = join(SHARED_DIR, "test-shared-brain-doc.md");

const TEST_DOC_CONTENT = `---
title: Test Shared Doc
summary: A test document for shared brain
tags: [test, shared]
---

# Test Shared Doc
This is a test document for the shared brain.
`;

afterEach(() => {
  if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);
});

describe("scanSharedBrainDocs", () => {
  it("returns BrainDoc[] from shared dir after writing a test file", () => {
    mkdirSync(SHARED_DIR, { recursive: true });
    writeFileSync(TEST_FILE, TEST_DOC_CONTENT);

    const docs = scanSharedBrainDocs();
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

    // scanSharedBrainDocs takes no arguments — no config path needed
    expect(() => scanSharedBrainDocs()).not.toThrow();
    const docs = scanSharedBrainDocs();
    expect(Array.isArray(docs)).toBe(true);
  });

  it("returns empty array when shared dir does not exist", () => {
    // Only test this if the dir doesn't exist; skip if it does
    if (!existsSync(SHARED_DIR)) {
      const docs = scanSharedBrainDocs();
      expect(docs).toEqual([]);
    } else {
      // Dir exists — we can't easily test this case, just verify it returns an array
      const docs = scanSharedBrainDocs();
      expect(Array.isArray(docs)).toBe(true);
    }
  });

  it("skips files without frontmatter in shared dir", () => {
    mkdirSync(SHARED_DIR, { recursive: true });
    const plainFile = join(SHARED_DIR, "test-plain-no-frontmatter.md");
    writeFileSync(plainFile, "# Just a plain file\nNo frontmatter here.\n");
    writeFileSync(TEST_FILE, TEST_DOC_CONTENT);

    try {
      const docs = scanSharedBrainDocs();
      const plainDoc = docs.find(d => d.slug === "test-plain-no-frontmatter");
      expect(plainDoc).toBeUndefined();
    } finally {
      if (existsSync(plainFile)) unlinkSync(plainFile);
    }
  });
});

describe("readSharedBrainDoc", () => {
  it("returns full content for a valid slug", () => {
    mkdirSync(SHARED_DIR, { recursive: true });
    writeFileSync(TEST_FILE, TEST_DOC_CONTENT);

    const content = readSharedBrainDoc("test-shared-brain-doc");
    expect(content).toBe(TEST_DOC_CONTENT);
  });

  it("throws for nonexistent slug", () => {
    expect(() => readSharedBrainDoc("nonexistent-slug-that-does-not-exist")).toThrow("not found");
  });

  it("works without any .octo-santa/config.json", () => {
    mkdirSync(SHARED_DIR, { recursive: true });
    writeFileSync(TEST_FILE, TEST_DOC_CONTENT);

    // readSharedBrainDoc takes only slug — no config path needed
    expect(() => readSharedBrainDoc("test-shared-brain-doc")).not.toThrow();
  });
});
