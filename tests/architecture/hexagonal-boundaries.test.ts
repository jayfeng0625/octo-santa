// Architecture tests enforcing hexagonal boundary rules: core stays free of
// infrastructure imports and adapters stay decoupled from each other.

import { describe, it, expect } from "bun:test";
import { projectFiles } from "archunit";
import type { FileInfo } from "archunit";

const CHECK_OPTS = { allowEmptyTests: true };
// The first rule check scans the whole project, which can exceed bun's 5s
// default when the suite runs in parallel.
const RULE_TIMEOUT_MS = 20_000;

// --- Helpers for custom import rules ---

const FORBIDDEN_CORE_IMPORTS = [
  /(?:from|import)\s+['"]bun:sqlite['"]/,
  /(?:from|import)\s+['"]@modelcontextprotocol\//,
  /require\(\s*['"]bun:sqlite['"]\s*\)/,
  /require\(\s*['"]@modelcontextprotocol\//,
];

function hasNoForbiddenImports(file: FileInfo): boolean {
  return FORBIDDEN_CORE_IMPORTS.every((re) => !re.test(file.content));
}

// --- Core must not depend on adapter layers ---

describe("hexagonal architecture boundaries", () => {
  describe("core must not depend on adapter layers", () => {
    it("core must not depend on storage layer", async () => {
      const rule = projectFiles()
        .inFolder("src/core/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/storage/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    }, RULE_TIMEOUT_MS);

    it("core must not depend on transports layer", async () => {
      const rule = projectFiles()
        .inFolder("src/core/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/transports/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    }, RULE_TIMEOUT_MS);

    it("core must not depend on notifications layer", async () => {
      const rule = projectFiles()
        .inFolder("src/core/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/notifications/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    }, RULE_TIMEOUT_MS);

    it("core must not depend on runtime layer", async () => {
      const rule = projectFiles()
        .inFolder("src/core/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/runtime/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    }, RULE_TIMEOUT_MS);
  });

  // --- Core must not import infrastructure modules directly ---

  describe("core must not import infrastructure modules", () => {
    it("core must not import bun:sqlite or @modelcontextprotocol", async () => {
      const rule = projectFiles()
        .inFolder("src/core/**")
        .should()
        .adhereTo(
          hasNoForbiddenImports,
          "Core files must not import bun:sqlite or @modelcontextprotocol"
        );

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    }, RULE_TIMEOUT_MS);
  });

  // --- No cross-adapter dependencies ---

  describe("no cross-adapter dependencies", () => {
    it("storage must not depend on transports", async () => {
      const rule = projectFiles()
        .inFolder("src/storage/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/transports/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    }, RULE_TIMEOUT_MS);

    it("storage must not depend on notifications", async () => {
      const rule = projectFiles()
        .inFolder("src/storage/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/notifications/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    }, RULE_TIMEOUT_MS);

    it("transports must not depend on storage", async () => {
      const rule = projectFiles()
        .inFolder("src/transports/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/storage/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    }, RULE_TIMEOUT_MS);

    it("transports must not depend on notifications", async () => {
      const rule = projectFiles()
        .inFolder("src/transports/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/notifications/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    }, RULE_TIMEOUT_MS);

    it("notifications must not depend on transports", async () => {
      const rule = projectFiles()
        .inFolder("src/notifications/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/transports/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    }, RULE_TIMEOUT_MS);

    it("notifications must not depend on storage", async () => {
      const rule = projectFiles()
        .inFolder("src/notifications/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/storage/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    }, RULE_TIMEOUT_MS);

    // The runtime layer (code execution) is an adapter like any other: it may
    // depend only on core, and no other adapter may depend on it.
    for (const other of ["storage", "transports", "notifications"]) {
      it(`runtime must not depend on ${other}`, async () => {
        const rule = projectFiles()
          .inFolder("src/runtime/**")
          .shouldNot()
          .dependOnFiles()
          .inFolder(`src/${other}/**`);

        const violations = await rule.check(CHECK_OPTS);
        expect(violations).toEqual([]);
      }, RULE_TIMEOUT_MS);

      it(`${other} must not depend on runtime`, async () => {
        const rule = projectFiles()
          .inFolder(`src/${other}/**`)
          .shouldNot()
          .dependOnFiles()
          .inFolder("src/runtime/**");

        const violations = await rule.check(CHECK_OPTS);
        expect(violations).toEqual([]);
      }, RULE_TIMEOUT_MS);
    }
  });
});
