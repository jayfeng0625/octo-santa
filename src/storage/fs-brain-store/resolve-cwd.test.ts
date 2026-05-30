import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveRepoCwd } from "./resolve-cwd";

const tmp = join(tmpdir(), `resolve-cwd-test-${Date.now()}`);

beforeAll(() => mkdirSync(tmp, { recursive: true }));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("resolveRepoCwd", () => {
  it("returns envCwd when set", () => {
    const result = resolveRepoCwd({ cwd: tmp, envCwd: "/explicit/path" });
    expect(result).toBe("/explicit/path");
  });

  it("falls back to cwd when no config found", () => {
    const empty = join(tmp, "no-config");
    mkdirSync(empty, { recursive: true });

    const result = resolveRepoCwd({ cwd: empty });
    expect(result).toBe(empty);
  });

  it("walks up to find .octo-santa/config.json", () => {
    const repo = join(tmp, "repo-root");
    const sub = join(repo, "deep", "nested");
    mkdirSync(join(repo, ".octo-santa"), { recursive: true });
    writeFileSync(join(repo, ".octo-santa", "config.json"), "{}");
    mkdirSync(sub, { recursive: true });

    const result = resolveRepoCwd({ cwd: sub });
    expect(result).toBe(repo);
  });

  it("envCwd takes priority over ancestor walk", () => {
    const repo = join(tmp, "repo-root");
    const sub = join(repo, "deep", "nested");

    const result = resolveRepoCwd({ cwd: sub, envCwd: "/override" });
    expect(result).toBe("/override");
  });
});
