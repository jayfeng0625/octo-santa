import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { YamlProfileStore } from "../../../src/storage/yaml-profiles/store";

describe("YamlProfileStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "profiles-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // --- Valid profile loading ---

  it("loads a valid profile with all fields", () => {
    writeFileSync(
      join(dir, "os-dev.yaml"),
      `name: os-dev\npersona: You are a senior OS engineer\nobjective: Build the kernel\nmaxInstances: 3\nautoJoinChannels:\n  - general\n  - os-team\n`
    );
    const store = new YamlProfileStore(dir);
    const profile = store.getProfile("os-dev");
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe("os-dev");
    expect(profile!.persona).toBe("You are a senior OS engineer");
    expect(profile!.objective).toBe("Build the kernel");
    expect(profile!.maxInstances).toBe(3);
    expect(profile!.autoJoinChannels).toEqual(["general", "os-team"]);
  });

  it("returns null for unknown profile name", () => {
    const store = new YamlProfileStore(dir);
    expect(store.getProfile("nonexistent")).toBeNull();
  });

  it("defaults maxInstances to 1 when not specified", () => {
    writeFileSync(join(dir, "simple.yaml"), `name: simple\n`);
    const store = new YamlProfileStore(dir);
    const profile = store.getProfile("simple");
    expect(profile!.maxInstances).toBe(1);
  });

  it("defaults persona to null when not specified", () => {
    writeFileSync(join(dir, "simple.yaml"), `name: simple\n`);
    const store = new YamlProfileStore(dir);
    const profile = store.getProfile("simple");
    expect(profile!.persona).toBeNull();
  });

  it("defaults objective to null when not specified", () => {
    writeFileSync(join(dir, "simple.yaml"), `name: simple\n`);
    const store = new YamlProfileStore(dir);
    const profile = store.getProfile("simple");
    expect(profile!.objective).toBeNull();
  });

  it("defaults autoJoinChannels to [] when not specified", () => {
    writeFileSync(join(dir, "simple.yaml"), `name: simple\n`);
    const store = new YamlProfileStore(dir);
    const profile = store.getProfile("simple");
    expect(profile!.autoJoinChannels).toEqual([]);
  });

  it("defaults instructions to null when not specified", () => {
    writeFileSync(join(dir, "simple.yaml"), `name: simple\n`);
    const store = new YamlProfileStore(dir);
    const profile = store.getProfile("simple");
    expect(profile!.instructions).toBeNull();
  });

  it("accepts null for persona explicitly", () => {
    writeFileSync(join(dir, "simple.yaml"), `name: simple\npersona: null\n`);
    const store = new YamlProfileStore(dir);
    expect(store.getProfile("simple")!.persona).toBeNull();
  });

  it("accepts null for objective explicitly", () => {
    writeFileSync(join(dir, "simple.yaml"), `name: simple\nobjective: null\n`);
    const store = new YamlProfileStore(dir);
    expect(store.getProfile("simple")!.objective).toBeNull();
  });

  it("loads instructions from profile YAML", () => {
    writeFileSync(
      join(dir, "os-pm.yaml"),
      `name: os-pm\ninstructions: "When you receive a proposal, evaluate it against priorities."\n`
    );
    const store = new YamlProfileStore(dir);
    const profile = store.getProfile("os-pm");
    expect(profile!.instructions).toBe(
      "When you receive a proposal, evaluate it against priorities."
    );
  });

  it("accepts null for instructions explicitly", () => {
    writeFileSync(join(dir, "simple.yaml"), `name: simple\ninstructions: null\n`);
    const store = new YamlProfileStore(dir);
    expect(store.getProfile("simple")!.instructions).toBeNull();
  });

  it("rejects non-string instructions (number)", () => {
    writeFileSync(join(dir, "bad.yaml"), `name: bad\ninstructions: 42\n`);
    expect(() => new YamlProfileStore(dir)).toThrow(/instructions/i);
  });

  it("rejects non-string instructions (boolean)", () => {
    writeFileSync(join(dir, "bad.yaml"), `name: bad\ninstructions: true\n`);
    expect(() => new YamlProfileStore(dir)).toThrow(/instructions/i);
  });

  // --- listProfiles and getBaseNames ---

  it("listProfiles returns all loaded profiles", () => {
    writeFileSync(join(dir, "alpha.yaml"), `name: alpha\n`);
    writeFileSync(join(dir, "beta.yaml"), `name: beta\n`);
    const store = new YamlProfileStore(dir);
    const profiles = store.listProfiles();
    expect(profiles.length).toBe(2);
    const names = profiles.map((p) => p.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });

  it("listProfiles returns empty array when no profiles", () => {
    const store = new YamlProfileStore(dir);
    expect(store.listProfiles()).toEqual([]);
  });

  it("getBaseNames returns a Set of profile names", () => {
    writeFileSync(join(dir, "alpha.yaml"), `name: alpha\n`);
    writeFileSync(join(dir, "beta.yaml"), `name: beta\n`);
    const store = new YamlProfileStore(dir);
    const names = store.getBaseNames();
    expect(names instanceof Set).toBe(true);
    expect(names.has("alpha")).toBe(true);
    expect(names.has("beta")).toBe(true);
    expect(names.size).toBe(2);
  });

  it("getBaseNames returns empty Set when no profiles", () => {
    const store = new YamlProfileStore(dir);
    expect(store.getBaseNames().size).toBe(0);
  });

  // --- Unknown fields: warn-and-ignore (F3) ---

  it("ignores unknown fields and loads successfully", () => {
    writeFileSync(
      join(dir, "simple.yaml"),
      `name: simple\nunknownField: some value\nanotherUnknown: 42\n`
    );
    // Should not throw
    const store = new YamlProfileStore(dir);
    const profile = store.getProfile("simple");
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe("simple");
  });

  // --- Validation errors that throw ---

  it("rejects reserved name 'all'", () => {
    writeFileSync(join(dir, "all.yaml"), `name: all\n`);
    expect(() => new YamlProfileStore(dir)).toThrow();
  });

  it("rejects reserved name 'here'", () => {
    writeFileSync(join(dir, "here.yaml"), `name: here\n`);
    expect(() => new YamlProfileStore(dir)).toThrow();
  });

  it("rejects reserved name '_system'", () => {
    writeFileSync(join(dir, "_system.yaml"), `name: _system\n`);
    expect(() => new YamlProfileStore(dir)).toThrow();
  });

  it("rejects filename mismatch (file is foo.yaml but name field is bar)", () => {
    writeFileSync(join(dir, "foo.yaml"), `name: bar\n`);
    expect(() => new YamlProfileStore(dir)).toThrow(/mismatch/i);
  });

  it("rejects maxInstances < 1", () => {
    writeFileSync(join(dir, "bad.yaml"), `name: bad\nmaxInstances: 0\n`);
    expect(() => new YamlProfileStore(dir)).toThrow(/maxInstances/i);
  });

  it("rejects maxInstances as negative", () => {
    writeFileSync(join(dir, "bad.yaml"), `name: bad\nmaxInstances: -1\n`);
    expect(() => new YamlProfileStore(dir)).toThrow(/maxInstances/i);
  });

  it("rejects maxInstances as non-integer (float)", () => {
    writeFileSync(join(dir, "bad.yaml"), `name: bad\nmaxInstances: 1.5\n`);
    expect(() => new YamlProfileStore(dir)).toThrow(/maxInstances/i);
  });

  it("loads a single profile into store", () => {
    // Note: duplicate name detection exists as a defensive guard but is structurally
    // unreachable — filename-must-match-name + filesystem unique filenames prevents it.
    writeFileSync(join(dir, "alpha.yaml"), `name: alpha\n`);
    const store = new YamlProfileStore(dir);
    expect(store.getBaseNames().size).toBe(1);
  });

  it("rejects non-string persona (number)", () => {
    writeFileSync(join(dir, "bad.yaml"), `name: bad\npersona: 42\n`);
    expect(() => new YamlProfileStore(dir)).toThrow(/persona/i);
  });

  it("rejects non-string persona (boolean)", () => {
    writeFileSync(join(dir, "bad.yaml"), `name: bad\npersona: true\n`);
    expect(() => new YamlProfileStore(dir)).toThrow(/persona/i);
  });

  it("rejects non-string objective (number)", () => {
    writeFileSync(join(dir, "bad.yaml"), `name: bad\nobjective: 99\n`);
    expect(() => new YamlProfileStore(dir)).toThrow(/objective/i);
  });

  it("rejects non-string objective (boolean)", () => {
    writeFileSync(join(dir, "bad.yaml"), `name: bad\nobjective: false\n`);
    expect(() => new YamlProfileStore(dir)).toThrow(/objective/i);
  });

  it("rejects non-string entries in autoJoinChannels", () => {
    writeFileSync(
      join(dir, "bad.yaml"),
      `name: bad\nautoJoinChannels:\n  - general\n  - 42\n`
    );
    expect(() => new YamlProfileStore(dir)).toThrow(/autoJoinChannels/i);
  });

  it("rejects autoJoinChannels when it's not an array", () => {
    writeFileSync(
      join(dir, "bad.yaml"),
      `name: bad\nautoJoinChannels: general\n`
    );
    expect(() => new YamlProfileStore(dir)).toThrow(/autoJoinChannels/i);
  });

  // --- ENOENT: nonexistent directory → empty store ---

  it("returns empty store when directory does not exist (ENOENT)", () => {
    const nonexistent = join(tmpdir(), "nonexistent-profiles-dir-99999999");
    const store = new YamlProfileStore(nonexistent);
    expect(store.listProfiles()).toEqual([]);
    expect(store.getBaseNames().size).toBe(0);
    expect(store.getProfile("anything")).toBeNull();
  });

  // --- Profile name collision with another profile's pool namespace ---

  it("rejects a profile whose name matches another profile's pool pattern (e.g., os-dev-2 when os-dev also loaded)", () => {
    writeFileSync(join(dir, "os-dev.yaml"), `name: os-dev\nmaxInstances: 5\n`);
    writeFileSync(join(dir, "os-dev-2.yaml"), `name: os-dev-2\n`);
    expect(() => new YamlProfileStore(dir)).toThrow(/os-dev-2/);
  });

  it("allows a profile like 'os-dev-extra' that is not a numeric suffix collision", () => {
    writeFileSync(join(dir, "os-dev.yaml"), `name: os-dev\nmaxInstances: 5\n`);
    writeFileSync(join(dir, "os-dev-extra.yaml"), `name: os-dev-extra\n`);
    // Should not throw: 'extra' is not a numeric suffix
    const store = new YamlProfileStore(dir);
    expect(store.getBaseNames().has("os-dev")).toBe(true);
    expect(store.getBaseNames().has("os-dev-extra")).toBe(true);
  });

  it("allows a profile like 'os-dev2' (no hyphen before digit) without collision", () => {
    writeFileSync(join(dir, "os-dev.yaml"), `name: os-dev\nmaxInstances: 5\n`);
    writeFileSync(join(dir, "os-dev2.yaml"), `name: os-dev2\n`);
    // No collision since the pattern is {name}-{digits}, not {name}{digits}
    const store = new YamlProfileStore(dir);
    expect(store.getBaseNames().has("os-dev")).toBe(true);
    expect(store.getBaseNames().has("os-dev2")).toBe(true);
  });

  it("rejects os-dev-10 when os-dev profile also loaded", () => {
    writeFileSync(join(dir, "os-dev.yaml"), `name: os-dev\nmaxInstances: 5\n`);
    writeFileSync(join(dir, "os-dev-10.yaml"), `name: os-dev-10\n`);
    expect(() => new YamlProfileStore(dir)).toThrow(/os-dev-10/);
  });

  it("does not reject numeric suffix when no matching base profile exists", () => {
    // os-dev-2 on its own is fine if there is no os-dev profile
    writeFileSync(join(dir, "os-dev-2.yaml"), `name: os-dev-2\n`);
    const store = new YamlProfileStore(dir);
    expect(store.getBaseNames().has("os-dev-2")).toBe(true);
  });

  // --- Invalid name format ---

  it("rejects profile name with invalid characters", () => {
    writeFileSync(join(dir, "bad name.yaml"), `name: bad name\n`);
    expect(() => new YamlProfileStore(dir)).toThrow();
  });
});
