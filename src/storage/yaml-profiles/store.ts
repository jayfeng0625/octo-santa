// src/storage/yaml-profiles/store.ts
//
// YAML filesystem adapter implementing ProfileRepository.
// Reads all .yaml files from a configured directory on construction.
// One bad file aborts startup (fail-fast).

import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import type { ProfileRepository } from "../../core/ports";
import type { AgentProfile } from "../../core/profiles/types";
import { validateAgentName } from "../../core/utils";
import { log } from "../../log";

// Known fields — unknown ones trigger a warning
const KNOWN_FIELDS = new Set([
  "name",
  "persona",
  "objective",
  "instructions",
  "maxInstances",
  "autoJoinChannels",
]);

// Pattern: <baseName>-<digits>
const POOL_SUFFIX_RE = /^(.+)-(\d+)$/;

function parseProfile(filePath: string, content: string): AgentProfile {
  const fileName = basename(filePath, ".yaml");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any = Bun.YAML.parse(content);

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Profile file "${filePath}" must contain a YAML mapping`);
  }

  // Warn about unknown fields
  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) {
      log(`Warning: unknown field "${key}" in profile "${filePath}" — ignoring`);
    }
  }

  // --- name ---
  const name: string = raw["name"];
  if (typeof name !== "string" || !name.trim()) {
    throw new Error(`Profile file "${filePath}": "name" must be a non-empty string`);
  }
  // Validates format ([\w-]+) and reserved names
  validateAgentName(name);

  // Filename must match name
  if (fileName !== name) {
    throw new Error(
      `Profile filename mismatch: file is "${fileName}.yaml" but name field is "${name}"`
    );
  }

  // --- persona ---
  const rawPersona = raw["persona"];
  let persona: string | null = null;
  if (rawPersona !== undefined && rawPersona !== null) {
    if (typeof rawPersona !== "string") {
      throw new Error(
        `Profile "${name}": persona must be a string or null/undefined, got ${typeof rawPersona}`
      );
    }
    persona = rawPersona;
  }

  // --- objective ---
  const rawObjective = raw["objective"];
  let objective: string | null = null;
  if (rawObjective !== undefined && rawObjective !== null) {
    if (typeof rawObjective !== "string") {
      throw new Error(
        `Profile "${name}": objective must be a string or null/undefined, got ${typeof rawObjective}`
      );
    }
    objective = rawObjective;
  }

  // --- instructions ---
  const rawInstructions = raw["instructions"];
  let instructions: string | null = null;
  if (rawInstructions !== undefined && rawInstructions !== null) {
    if (typeof rawInstructions !== "string") {
      throw new Error(
        `Profile "${name}": instructions must be a string or null/undefined, got ${typeof rawInstructions}`
      );
    }
    instructions = rawInstructions;
  }

  // --- maxInstances ---
  const rawMax = raw["maxInstances"];
  let maxInstances = 1;
  if (rawMax !== undefined && rawMax !== null) {
    if (typeof rawMax !== "number" || !Number.isInteger(rawMax) || rawMax < 1) {
      throw new Error(
        `Profile "${name}": maxInstances must be a positive integer >= 1, got ${rawMax}`
      );
    }
    maxInstances = rawMax;
  }

  // --- autoJoinChannels ---
  const rawChannels = raw["autoJoinChannels"];
  let autoJoinChannels: string[] = [];
  if (rawChannels !== undefined && rawChannels !== null) {
    if (!Array.isArray(rawChannels)) {
      throw new Error(
        `Profile "${name}": autoJoinChannels must be an array of strings`
      );
    }
    for (let i = 0; i < rawChannels.length; i++) {
      if (typeof rawChannels[i] !== "string") {
        throw new Error(
          `Profile "${name}": autoJoinChannels[${i}] must be a string, got ${typeof rawChannels[i]}`
        );
      }
    }
    autoJoinChannels = rawChannels as string[];
  }

  return { name, persona, objective, instructions, maxInstances, autoJoinChannels };
}

function checkPoolNameCollisions(profiles: AgentProfile[]): void {
  const nameSet = new Set(profiles.map((p) => p.name));
  for (const profile of profiles) {
    const m = POOL_SUFFIX_RE.exec(profile.name);
    if (m) {
      const baseName = m[1]!;
      if (nameSet.has(baseName)) {
        throw new Error(
          `Profile name "${profile.name}" collides with pool namespace of profile "${baseName}". ` +
          `Instance names like "${profile.name}" are reserved for the pool of "${baseName}".`
        );
      }
    }
  }
}

export class YamlProfileStore implements ProfileRepository {
  private readonly profiles: Map<string, AgentProfile>;

  constructor(dirPath: string) {
    this.profiles = new Map();
    this.load(dirPath);
  }

  private load(dirPath: string): void {
    let files: string[];
    try {
      files = readdirSync(dirPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        // Directory doesn't exist — silently treat as empty
        return;
      }
      throw err;
    }

    const yamlFiles = files.filter((f) => f.endsWith(".yaml")).sort();
    const parsed: AgentProfile[] = [];

    for (const file of yamlFiles) {
      const filePath = join(dirPath, file);
      const content = readFileSync(filePath, "utf-8");
      const profile = parseProfile(filePath, content);

      // Check for duplicate names (defensive; filesystem prevents same basename)
      if (this.profiles.has(profile.name)) {
        throw new Error(
          `Duplicate profile name "${profile.name}" found in directory "${dirPath}"`
        );
      }

      parsed.push(profile);
      this.profiles.set(profile.name, profile);
    }

    // After all files parsed, check pool namespace collisions
    checkPoolNameCollisions(parsed);
  }

  getProfile(baseName: string): AgentProfile | null {
    return this.profiles.get(baseName) ?? null;
  }

  listProfiles(): AgentProfile[] {
    return [...this.profiles.values()];
  }

  getBaseNames(): Set<string> {
    return new Set(this.profiles.keys());
  }
}
