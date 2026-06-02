// tests/contracts/contracts-imports.test.ts
//
// Architecture test for the thin-core product seam (spec §1, §5 OD-7).
// src/contracts/index.ts is PURE TYPES — zero runtime deps, zero infrastructure imports.
// It must NOT import bun:sqlite, @modelcontextprotocol/*, or any adapter layer
// (src/storage, src/transports, src/notifications).

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";

const CONTRACTS_PATH = new URL(
  "../../src/contracts/index.ts",
  import.meta.url
).pathname;

const FORBIDDEN_IMPORTS = [
  /(?:from|import)\s+['"]bun:sqlite['"]/,
  /(?:from|import)\s+['"]@modelcontextprotocol\//,
  /(?:from|import)\s+['"][^'"]*\/storage\//,
  /(?:from|import)\s+['"][^'"]*\/transports\//,
  /(?:from|import)\s+['"][^'"]*\/notifications\//,
  /require\(\s*['"]bun:sqlite['"]\s*\)/,
  /require\(\s*['"]@modelcontextprotocol\//,
];

describe("contracts seam — forbidden imports", () => {
  it("src/contracts/index.ts contains no infrastructure imports", () => {
    const content = readFileSync(CONTRACTS_PATH, "utf8");
    for (const re of FORBIDDEN_IMPORTS) {
      expect(re.test(content)).toBe(false);
    }
  });
});
