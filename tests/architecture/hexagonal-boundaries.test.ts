// tests/architecture/hexagonal-boundaries.test.ts
//
// Architecture tests enforcing hexagonal boundary rules.
// These guard the core domain from infrastructure imports and cross-adapter coupling.
// Written before the refactor begins — they pass vacuously until src/core/ exists,
// then actively enforce boundaries as code is extracted.

import { describe, it, expect } from "bun:test";
import { readdirSync } from "node:fs";
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

  // --- Contracts seam must stay a PURE seam (zero infra, not a second port home) ---

  describe("contracts seam must stay pure", () => {
    it("contracts must not depend on storage layer", async () => {
      const rule = projectFiles()
        .inFolder("src/contracts/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/storage/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    });

    it("contracts must not depend on transports layer", async () => {
      const rule = projectFiles()
        .inFolder("src/contracts/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/transports/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    });

    it("contracts must not depend on notifications layer", async () => {
      const rule = projectFiles()
        .inFolder("src/contracts/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/notifications/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    });

    it("contracts must not depend on adapters layer", async () => {
      const rule = projectFiles()
        .inFolder("src/contracts/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/adapters/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    });

    it("contracts must not depend on core (a pure seam is not a second port home)", async () => {
      const rule = projectFiles()
        .inFolder("src/contracts/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/core/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    });

    it("contracts must not import bun:sqlite or @modelcontextprotocol (folder-wide)", async () => {
      const rule = projectFiles()
        .inFolder("src/contracts/**")
        .should()
        .adhereTo(
          hasNoForbiddenImports,
          "Contracts files must not import bun:sqlite or @modelcontextprotocol"
        );

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    });

    // Non-vacuity guard (subsumes the deleted tests/contracts/contracts-imports.test.ts):
    // the archunit contracts rules above run with allowEmptyTests:true and would pass on an
    // empty folder. src/contracts/ exists today, so assert it is populated — any future file
    // under it is then held to the purity rules above rather than silently uncovered.
    it("src/contracts/ is non-empty so the purity rules above are not vacuous", () => {
      const dir = new URL("../../src/contracts/", import.meta.url).pathname;
      const tsFiles = readdirSync(dir, { recursive: true }).filter(
        (f) => typeof f === "string" && f.endsWith(".ts")
      );
      expect(tsFiles.length).toBeGreaterThan(0);
    });
  });

  // --- No cross-adapter dependencies ---

  describe("no cross-adapter dependencies", () => {
    it("adapters must not depend on transports", async () => {
      const rule = projectFiles()
        .inFolder("src/adapters/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/transports/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    });

    it("adapters must not depend on notifications", async () => {
      const rule = projectFiles()
        .inFolder("src/adapters/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/notifications/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    });

    it("adapters must not depend on storage", async () => {
      const rule = projectFiles()
        .inFolder("src/adapters/**")
        .shouldNot()
        .dependOnFiles()
        .inFolder("src/storage/**");

      const violations = await rule.check(CHECK_OPTS);
      expect(violations).toEqual([]);
    });

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
