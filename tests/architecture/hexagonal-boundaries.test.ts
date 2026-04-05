// tests/architecture/hexagonal-boundaries.test.ts
//
// Architecture tests enforcing hexagonal boundary rules.
// These guard the core domain from infrastructure imports and cross-adapter coupling.
// Written before the refactor begins — they pass vacuously until src/core/ exists,
// then actively enforce boundaries as code is extracted.

import { describe, it, expect } from "bun:test";
import { projectFiles } from "archunit";
import type { FileInfo } from "archunit";

const CHECK_OPTS = { allowEmptyTests: true };

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
    });

    it("core must not depend on transports layer", async () => {
      const rule = projectFiles()
        .inFolder("src/core/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/transports/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    });

    it("core must not depend on notifications layer", async () => {
      const rule = projectFiles()
        .inFolder("src/core/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/notifications/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    });
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
    });
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
    });

    it("storage must not depend on notifications", async () => {
      const rule = projectFiles()
        .inFolder("src/storage/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/notifications/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    });

    it("transports must not depend on storage", async () => {
      const rule = projectFiles()
        .inFolder("src/transports/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/storage/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    });

    it("transports must not depend on notifications", async () => {
      const rule = projectFiles()
        .inFolder("src/transports/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/notifications/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    });

    it("notifications must not depend on transports", async () => {
      const rule = projectFiles()
        .inFolder("src/notifications/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/transports/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    });

    it("notifications must not depend on storage", async () => {
      const rule = projectFiles()
        .inFolder("src/notifications/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/storage/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    });
  });
});
