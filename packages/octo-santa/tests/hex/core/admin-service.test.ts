import { describe, it, expect } from "bun:test";
import { AdminService } from "../../../src/core/admin/service";
import type { AdminModulePort, CodeRunnerPort } from "../../../src/core/ports";
import type { CodeRunResult } from "../../../src/core/admin/types";

// Core-level tests with fake ports: the service must stay agnostic about
// what module APIs do — search only reads the declarations modules author,
// execute only composes bindings and delegates opaque code to the runner.

function makeFakeRunner(outcome: CodeRunResult = { result: "ok", logs: [] }) {
  const calls: { code: string; bindings: Record<string, object> }[] = [];
  const runner: CodeRunnerPort = {
    language: "typescript",
    reservedNames: ["console"],
    run: async (code, bindings) => {
      calls.push({ code, bindings });
      return outcome;
    },
  };
  return { runner, calls };
}

function makeFakeModule(name: string, provider = "fake"): AdminModulePort {
  return {
    describe: () => ({
      globalName: name,
      provider,
      typehead: `\
/** Fetches the ${name} things. */
interface ${name}Api {
  /** Fetch every thing currently stored. */
  fetchThings(): string[];
}

declare const ${name}: ${name}Api;
`,
    }),
    createApi: () => ({ api: name }),
  };
}

describe("AdminService.execute", () => {
  it("binds every module's API as a global, keyed by module name", async () => {
    const { runner, calls } = makeFakeRunner();
    const svc = new AdminService(runner, [makeFakeModule("storage"), makeFakeModule("other")]);
    await svc.execute("return 1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.code).toBe("return 1");
    expect(calls[0]!.bindings).toEqual({
      storage: { api: "storage" },
      other: { api: "other" },
    });
  });

  it("rejects empty and whitespace-only code", async () => {
    const svc = new AdminService(makeFakeRunner().runner, [makeFakeModule("m")]);
    expect(svc.execute("")).rejects.toThrow("code must not be empty");
    expect(svc.execute("  \n ")).rejects.toThrow("code must not be empty");
  });

  it("normalizes undefined results to null and passes logs through", async () => {
    const { runner } = makeFakeRunner({ result: undefined, logs: ["[log] hi"] });
    const svc = new AdminService(runner, [makeFakeModule("m")]);
    expect(await svc.execute("code")).toEqual({ result: null, logs: ["[log] hi"] });
  });

  it("rejects non-JSON-serializable results with a clear error", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { runner } = makeFakeRunner({ result: cyclic, logs: [] });
    const svc = new AdminService(runner, [makeFakeModule("m")]);
    expect(svc.execute("code")).rejects.toThrow("cannot be written as JSON");
  });
});

describe("AdminService.search", () => {
  it("finds declarations across modules by keyword — discovery, not execution", () => {
    const { runner, calls } = makeFakeRunner();
    const svc = new AdminService(runner, [makeFakeModule("storage"), makeFakeModule("other")]);
    const found = svc.search("fetch things");
    expect(found.matches.length).toBeGreaterThan(0);
    expect(found.matches[0]!.name).toBe("fetchThings");
    expect(found.matches[0]!.declaration).toContain("fetchThings(): string[]");
    // Both modules declare it; both should surface.
    expect(new Set(found.matches.map((m) => m.module))).toEqual(
      new Set(["storage", "other"])
    );
    // Search never touches the runner.
    expect(calls).toHaveLength(0);
  });

  it("caps matches at the limit while reporting the total", () => {
    const svc = new AdminService(makeFakeRunner().runner, [
      makeFakeModule("storage"),
      makeFakeModule("other"),
    ]);
    const found = svc.search("fetch things", 1);
    expect(found.matches).toHaveLength(1);
    expect(found.total).toBeGreaterThan(1);
  });

  it("rejects empty queries and returns nothing for unknown terms", () => {
    const svc = new AdminService(makeFakeRunner().runner, [makeFakeModule("m")]);
    expect(() => svc.search("  ")).toThrow("query must not be empty");
    expect(svc.search("zebra carousel")).toEqual({ matches: [], total: 0 });
  });
});

describe("AdminService construction and describe", () => {
  it("rejects duplicate and runner-reserved module names at construction", () => {
    const { runner } = makeFakeRunner();
    expect(
      () => new AdminService(runner, [makeFakeModule("m"), makeFakeModule("m")])
    ).toThrow('Duplicate admin module name "m"');
    expect(() => new AdminService(runner, [makeFakeModule("console")])).toThrow(
      'Admin module name "console" is reserved'
    );
  });

  it("composes the typehead from core's header plus each module's fragment", () => {
    const svc = new AdminService(makeFakeRunner().runner, [
      makeFakeModule("storage", "sqlite"),
      makeFakeModule("other", "x"),
    ]);
    const description = svc.describe();
    expect(description.language).toBe("typescript");
    expect(description.modules).toEqual([
      { globalName: "storage", provider: "sqlite" },
      { globalName: "other", provider: "x" },
    ]);
    // Header documents the two operations and the execution model...
    expect(description.typehead).toContain("Search looks up methods and types");
    expect(description.typehead).toContain("body of an async function");
    // ...without naming MCP tools: those belong to the transport, not core.
    expect(description.typehead).not.toContain("admin_search");
    // ...and every module fragment follows, in order.
    const storageIdx = description.typehead.indexOf("declare const storage");
    const otherIdx = description.typehead.indexOf("declare const other");
    expect(storageIdx).toBeGreaterThan(0);
    expect(otherIdx).toBeGreaterThan(storageIdx);
  });
});
