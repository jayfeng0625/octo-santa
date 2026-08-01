import { describe, it, expect } from "bun:test";
import { TypeScriptRunner } from "../../../src/runtime/typescript/runner";

describe("TypeScriptRunner", () => {
  it("runs TypeScript (with type annotations) and returns the returned value", async () => {
    const runner = new TypeScriptRunner();
    const outcome = await runner.run(
      `const doubled: number[] = [1, 2, 3].map((n: number) => n * 2);
       return { doubled };`,
      {}
    );
    expect(outcome.result).toEqual({ doubled: [2, 4, 6] });
  });

  it("exposes bindings as globals and supports await", async () => {
    const runner = new TypeScriptRunner();
    const api = {
      fetchThings: async () => [{ id: 1 }, { id: 2 }],
    };
    const outcome = await runner.run(
      `const things = await storage.fetchThings();
       return things.length;`,
      { storage: api }
    );
    expect(outcome.result).toBe(2);
  });

  it("captures console output into logs", async () => {
    const runner = new TypeScriptRunner();
    const outcome = await runner.run(
      `console.log("checking", { n: 1 });
       console.warn("careful");
       return null;`,
      {}
    );
    expect(outcome.logs).toEqual(['[log] checking {"n":1}', "[warn] careful"]);
  });

  it("returns undefined result when the code returns nothing", async () => {
    const runner = new TypeScriptRunner();
    const outcome = await runner.run(`const x = 1;`, {});
    expect(outcome.result).toBeUndefined();
  });

  it("rejects static imports, require calls, and dynamic imports", async () => {
    const runner = new TypeScriptRunner();
    expect(runner.run(`import fs from "fs"; return 1;`, {})).rejects.toThrow(
      "imports are not allowed"
    );
    expect(runner.run(`const fs = require("fs"); return 1;`, {})).rejects.toThrow(
      "imports are not allowed"
    );
    expect(runner.run(`const m = await import("fs"); return 1;`, {})).rejects.toThrow(
      "imports are not allowed"
    );
  });

  it("shadows the ambient host identifiers to undefined inside runs", async () => {
    // `typeof` is deliberately avoided: Bun's transpiler constant-folds
    // `typeof require` at transform time, before runtime shadowing applies.
    // Reading the bare identifiers reflects the actual runtime binding.
    const runner = new TypeScriptRunner();
    const outcome = await runner.run(
      `return {
         proc: process === undefined,
         bun: Bun === undefined,
         req: require === undefined,
         mod: module === undefined,
         exp: exports === undefined,
       };`,
      {}
    );
    expect(outcome.result).toEqual({ proc: true, bun: true, req: true, mod: true, exp: true });
  });

  it("rejects bindings that collide with reserved names", async () => {
    const runner = new TypeScriptRunner();
    expect(runner.run("return 1", { console: {} })).rejects.toThrow("reserved");
    expect(runner.run("return 1", { process: {} })).rejects.toThrow("reserved");
  });

  it("surfaces errors thrown by the code", async () => {
    const runner = new TypeScriptRunner();
    expect(
      runner.run(`throw new Error("boom from code");`, {})
    ).rejects.toThrow("boom from code");
  });

  it("surfaces syntax errors without crashing", async () => {
    const runner = new TypeScriptRunner();
    expect(runner.run(`const = broken(;`, {})).rejects.toThrow();
  });

  it("times out hung awaits", async () => {
    const runner = new TypeScriptRunner(50);
    expect(
      runner.run(`await new Promise(() => {}); return 1;`, {})
    ).rejects.toThrow("timed out after 50ms");
  });
});
