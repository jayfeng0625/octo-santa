import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readConfig, validateBrainDir } from "../../src/modules/brain/tools";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "octo-santa-test-config-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("readConfig", () => {
  it("returns parsed config for a valid .octo-santa/config.json", () => {
    const tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, ".octo-santa"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".octo-santa", "config.json"),
      JSON.stringify({
        domain: {
          identifier: "my-project",
          tags: ["typescript", "api"],
          description: "My project domain",
        },
        brain: { dirs: ["./brain"] },
      })
    );

    const config = readConfig(tmpDir);
    expect(config).not.toBeNull();
    expect(config!.domain!.identifier).toBe("my-project");
    expect(config!.domain!.tags).toEqual(["typescript", "api"]);
    expect(config!.domain!.description).toBe("My project domain");
    expect(config!.brain!.dirs).toEqual(["./brain"]);
  });

  it("returns null when config file does not exist", () => {
    const tmpDir = makeTmpDir();
    const config = readConfig(tmpDir);
    expect(config).toBeNull();
  });

  it("returns null for malformed JSON (no throw)", () => {
    const tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, ".octo-santa"), { recursive: true });
    writeFileSync(join(tmpDir, ".octo-santa", "config.json"), "{ not valid json !!!");

    expect(() => readConfig(tmpDir)).not.toThrow();
    const config = readConfig(tmpDir);
    expect(config).toBeNull();
  });

  it("returns partial config when optional fields are missing", () => {
    const tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, ".octo-santa"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".octo-santa", "config.json"),
      JSON.stringify({ brain: { dirs: ["./brain"] } })
    );

    const config = readConfig(tmpDir);
    expect(config).not.toBeNull();
    expect(config!.brain!.dirs).toEqual(["./brain"]);
    expect(config!.domain).toBeUndefined();
  });

  it("returns null for invalid schema — missing identifier in domain", () => {
    const tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, ".octo-santa"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".octo-santa", "config.json"),
      JSON.stringify({
        domain: {
          // missing identifier
          tags: ["typescript"],
          description: "A domain",
        },
      })
    );

    const config = readConfig(tmpDir);
    expect(config).toBeNull();
  });

  it("returns null for invalid schema — empty identifier", () => {
    const tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, ".octo-santa"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".octo-santa", "config.json"),
      JSON.stringify({
        domain: {
          identifier: "",
          tags: [],
          description: "empty identifier",
        },
      })
    );

    const config = readConfig(tmpDir);
    expect(config).toBeNull();
  });
});

describe("validateBrainDir", () => {
  it("resolves a simple relative path within CWD", () => {
    const tmpDir = makeTmpDir();
    const result = validateBrainDir(tmpDir, "brain");
    expect(result).toBe(join(tmpDir, "brain"));
  });

  it("resolves a path with ./ prefix", () => {
    const tmpDir = makeTmpDir();
    const result = validateBrainDir(tmpDir, "./brain");
    expect(result).toBe(join(tmpDir, "brain"));
  });

  it("throws for absolute path", () => {
    const tmpDir = makeTmpDir();
    expect(() => validateBrainDir(tmpDir, "/absolute/path")).toThrow("must be relative");
  });

  it("throws for path containing ..", () => {
    const tmpDir = makeTmpDir();
    expect(() => validateBrainDir(tmpDir, "../sibling")).toThrow("must not contain");
  });

  it("throws for path that would escape CWD via nested ..", () => {
    const tmpDir = makeTmpDir();
    // Embed .. in the middle
    expect(() => validateBrainDir(tmpDir, "subdir/../../../etc")).toThrow("must not contain");
  });

  it("resolves nested relative paths correctly", () => {
    const tmpDir = makeTmpDir();
    const result = validateBrainDir(tmpDir, "docs/brain");
    expect(result).toBe(join(tmpDir, "docs", "brain"));
  });

  it("works with root CWD", () => {
    const result = validateBrainDir("/", "brain");
    expect(result).toBe("/brain");
  });

  it("resolves path with trailing slash", () => {
    const tmpDir = makeTmpDir();
    const result = validateBrainDir(tmpDir, "brain/");
    expect(result).toBe(join(tmpDir, "brain"));
  });

  it("accepts directory names starting with '..' like '..bar' (not a traversal)", () => {
    const tmpDir = makeTmpDir();
    const result = validateBrainDir(tmpDir, "..bar");
    expect(result).toBe(join(tmpDir, "..bar"));
  });
});
