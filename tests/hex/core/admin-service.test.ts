import { describe, it, expect } from "bun:test";
import { AdminService } from "../../../src/core/admin/service";
import type { AdminModulePort, CodeRunnerPort } from "../../../src/core/ports";
import type { CodeRunResult } from "../../../src/core/admin/types";

// Core-level tests with fake ports: the service must stay agnostic about
// what module APIs do — it only composes bindings and typeheads, delegates
// opaque code to the runner, and normalizes outcomes.

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
      typehead: `declare const ${name}: unknown; // ${provider}`,
    }),
    createReadApi: () => ({ kind: "search", module: name }),
    createWriteApi: () => ({ kind: "execute", module: name }),
  };
}

describe("AdminService", () => {
  it("binds each module's read-only API for search, keyed by module name", async () => {
    const { runner, calls } = makeFakeRunner();
    const svc = new AdminService(runner, [makeFakeModule("storage"), makeFakeModule("other")]);
    await svc.search("return 1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.code).toBe("return 1");
    expect(calls[0]!.bindings).toEqual({
      storage: { kind: "search", module: "storage" },
      other: { kind: "search", module: "other" },
    });
  });

  it("binds each module's full API for execute", async () => {
    const { runner, calls } = makeFakeRunner();
    const svc = new AdminService(runner, [makeFakeModule("storage")]);
    await svc.execute("return 1");
    expect(calls[0]!.bindings).toEqual({
      storage: { kind: "execute", module: "storage" },
    });
  });

  it("rejects empty and whitespace-only code", async () => {
    const svc = new AdminService(makeFakeRunner().runner, [makeFakeModule("m")]);
    expect(svc.search("")).rejects.toThrow("code must not be empty");
    expect(svc.execute("  \n ")).rejects.toThrow("code must not be empty");
  });

  it("rejects duplicate and runner-reserved module names at construction", () => {
    const { runner } = makeFakeRunner();
    expect(
      () => new AdminService(runner, [makeFakeModule("m"), makeFakeModule("m")])
    ).toThrow('Duplicate admin module name "m"');
    expect(() => new AdminService(runner, [makeFakeModule("console")])).toThrow(
      'Admin module name "console" is reserved'
    );
  });

  it("normalizes undefined results to null and passes logs through", async () => {
    const { runner } = makeFakeRunner({ result: undefined, logs: ["[log] hi"] });
    const svc = new AdminService(runner, [makeFakeModule("m")]);
    expect(await svc.search("code")).toEqual({ result: null, logs: ["[log] hi"] });
  });

  it("rejects non-JSON-serializable results with a clear error", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { runner } = makeFakeRunner({ result: cyclic, logs: [] });
    const svc = new AdminService(runner, [makeFakeModule("m")]);
    expect(svc.search("code")).rejects.toThrow("cannot be written as JSON");
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
    // Header documents the execution model...
    expect(description.typehead).toContain("body of an async function");
    expect(description.typehead).toContain("A read-only run binds each module");
    // ...without naming MCP tools: those belong to the transport, not core.
    expect(description.typehead).not.toContain("admin_search");
    // ...and every module fragment follows, in order.
    const storageIdx = description.typehead.indexOf("declare const storage");
    const otherIdx = description.typehead.indexOf("declare const other");
    expect(storageIdx).toBeGreaterThan(0);
    expect(otherIdx).toBeGreaterThan(storageIdx);
  });
});
