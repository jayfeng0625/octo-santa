// tests/contracts/contracts-imports.test.ts
//
// Architecture test for the thin-core product seam (spec §1, §5 OD-7).
// src/contracts/index.ts is PURE TYPES — zero runtime deps, zero infrastructure imports.
// It must NOT import bun:sqlite, @modelcontextprotocol/*, or any adapter layer
// (src/storage, src/transports, src/notifications).

import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

const CONTRACTS_DIR = new URL("../../src/contracts/", import.meta.url).pathname;

// Scan the WHOLE src/contracts/ folder recursively — not a single pinned file — so any
// future file under it (e.g. the named metadata.content-type extension, spec §2.8) is held
// to the same purity rule and cannot escape the check (Finding F7).
function contractsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}${entry.name}`;
    if (entry.isDirectory()) out.push(...contractsFiles(`${full}/`));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

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
  it("every file under src/contracts/ contains no infrastructure imports", () => {
    const files = contractsFiles(CONTRACTS_DIR);
    expect(files.length).toBeGreaterThan(0); // guard against a silently-empty scan
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const re of FORBIDDEN_IMPORTS) {
        expect(re.test(content)).toBe(false);
      }
    }
  });
});
