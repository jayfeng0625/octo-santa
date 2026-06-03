// tests/conformance/adapter-coverage.test.ts
//
// Structural guard: every adapter under src/adapters/ MUST be proven by the conformance
// suite. archunit enforces import boundaries but cannot assert "this adapter runs the
// suite" — that is behavioral wiring, not a dependency rule. So this is a file-structure
// rule: for each src/adapters/<name>/, some tests/conformance/*.test.ts must call
// runConformanceSuite AND reference that adapter (anchored on its import path).
//
// Stops a future adapter (e.g. a Phase B durable backend) from shipping unproven and green:
// add a new adapter folder without a conformance test that runs it, and this test fails.

import { describe, it, expect } from "bun:test";
import { basename } from "node:path";
import { readdirSync, readFileSync } from "node:fs";

const ADAPTERS_DIR = new URL("../../src/adapters/", import.meta.url).pathname;
const CONFORMANCE_DIR = new URL("./", import.meta.url).pathname;
const SELF = basename(new URL(import.meta.url).pathname); // exclude this file from the scan

function adapterNames(): string[] {
  return readdirSync(ADAPTERS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

// Conformance test files that actually run the suite, concatenated for substring search.
// This file is EXCLUDED: it mentions runConformanceSuite/adapter paths in prose and would
// otherwise satisfy its own check (false-pass).
function conformanceWiring(): string {
  return readdirSync(CONFORMANCE_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".test.ts") && e.name !== SELF)
    .map((e) => readFileSync(`${CONFORMANCE_DIR}${e.name}`, "utf8"))
    .filter((content) => content.includes("runConformanceSuite("))
    .join("\n");
}

describe("conformance coverage — every adapter is proven by the suite", () => {
  it("each src/adapters/<name> is wired into a conformance test", () => {
    const adapters = adapterNames();
    expect(adapters.length).toBeGreaterThan(0); // non-vacuity

    const wiring = conformanceWiring();
    for (const name of adapters) {
      // anchored on the adapter import path, not a free-text suite label
      expect(wiring).toContain(`adapters/${name}/`);
    }
  });
});
