import { readFileSync, existsSync, readdirSync } from "fs";
import { basename, join, resolve, normalize, relative, isAbsolute, sep } from "path";
import { homedir } from "os";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { BrainStore } from "../../core/ports.ts";
import type { BrainDoc, OctoSantaConfig } from "../../core/brain/types.ts";
import { log } from "../../log";

// ---------------------------------------------------------------------------
// Helpers (extracted from legacy src/modules/brain/tools.ts)
// ---------------------------------------------------------------------------

/** Check if a resolved path escapes its parent via path.relative(). */
function escapesParent(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

export function validateBrainDir(cwd: string, dir: string): string {
  if (isAbsolute(dir)) throw new Error(`brain.dirs path must be relative, got "${dir}"`);
  const segments = dir.replace(/\\/g, "/").split("/");
  if (segments.includes("..")) throw new Error(`brain.dirs path must not contain "..", got "${dir}"`);
  const resolved = resolve(cwd, dir);
  if (escapesParent(cwd, resolved)) {
    throw new Error(`brain.dirs path escapes CWD: "${dir}"`);
  }
  return resolved;
}

function parseFrontmatter(content: string): { title: string; summary: string; tags: string[] } | null {
  if (!content.startsWith("---")) return null;
  const endIdx = content.indexOf("---", 3);
  if (endIdx === -1) return null;
  try {
    const parsed = parseYaml(content.slice(3, endIdx));
    if (!parsed || typeof parsed.title !== "string") return null;
    return {
      title: parsed.title,
      summary: parsed.summary ?? "",
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    };
  } catch {
    return null;
  }
}

function scanFile(cwd: string, absPath: string, docs: BrainDoc[]): void {
  const content = readFileSync(absPath, "utf-8");
  const fm = parseFrontmatter(content);
  const slug = basename(absPath).replace(/\.md$/, "");
  docs.push({
    slug,
    path: `./${relative(cwd, absPath).replace(/\\/g, "/")}`,
    title: fm?.title ?? slug,
    summary: fm?.summary ?? "",
    tags: fm?.tags ?? [],
  });
}

function getSharedBrainDir(): string {
  return join(homedir(), ".octo-santa", "brain");
}

// ---------------------------------------------------------------------------
// Config reading
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  domain: z.object({
    identifier: z.string().min(1),
    tags: z.array(z.string()),
    description: z.string().min(1),
  }).optional(),
  brain: z.object({
    dirs: z.array(z.string().min(1)),
    files: z.array(z.string().min(1)).optional(),
  }).optional(),
});

export function readConfig(cwd: string): OctoSantaConfig | null {
  const configPath = join(cwd, ".octo-santa", "config.json");
  if (!existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    return ConfigSchema.parse(raw);
  } catch (err) {
    log(`Warning: malformed .octo-santa/config.json — ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// FsBrainStore
// ---------------------------------------------------------------------------

export class FsBrainStore implements BrainStore {
  private readonly cwd: string;
  private readonly dirs: string[];
  private readonly files: string[];
  private readonly sharedBrainDir: string;

  constructor(cwd: string, dirs?: string[], files?: string[], sharedBrainDir?: string) {
    this.cwd = cwd;
    this.dirs = dirs ?? [];
    this.files = files ?? [];
    this.sharedBrainDir = sharedBrainDir ?? getSharedBrainDir();
  }

  scanDocs(): BrainDoc[] {
    const docs: BrainDoc[] = [];
    const seen = new Set<string>();
    for (const dir of this.dirs) {
      const absDir = validateBrainDir(this.cwd, dir);
      if (!existsSync(absDir)) continue;
      const dirFiles = readdirSync(absDir).filter(f => f.endsWith(".md")).sort();
      for (const file of dirFiles) {
        const absPath = join(absDir, file);
        seen.add(absPath);
        scanFile(this.cwd, absPath, docs);
      }
    }
    for (const file of this.files) {
      const absPath = resolve(this.cwd, file);
      if (escapesParent(this.cwd, absPath)) continue;
      if (!existsSync(absPath) || !absPath.endsWith(".md")) continue;
      if (seen.has(absPath)) continue;
      scanFile(this.cwd, absPath, docs);
    }
    return docs;
  }

  readDoc(slug: string): string {
    for (const dir of this.dirs) {
      const absDir = validateBrainDir(this.cwd, dir);
      const filePath = join(absDir, `${slug}.md`);
      if (existsSync(filePath)) {
        if (escapesParent(absDir, normalize(filePath))) {
          throw new Error(`slug "${slug}" escapes brain directory`);
        }
        return readFileSync(filePath, "utf-8");
      }
    }
    for (const file of this.files) {
      const absPath = resolve(this.cwd, file);
      if (basename(absPath).replace(/\.md$/, "") === slug) {
        if (escapesParent(this.cwd, absPath)) throw new Error(`file "${file}" escapes CWD`);
        if (existsSync(absPath)) return readFileSync(absPath, "utf-8");
      }
    }
    throw new Error(`brain doc "${slug}" not found`);
  }

  scanSharedDocs(): BrainDoc[] {
    if (!existsSync(this.sharedBrainDir)) return [];
    const files = readdirSync(this.sharedBrainDir).filter(f => f.endsWith(".md")).sort();
    const docs: BrainDoc[] = [];
    for (const file of files) {
      const content = readFileSync(join(this.sharedBrainDir, file), "utf-8");
      const fm = parseFrontmatter(content);
      const slug = file.replace(/\.md$/, "");
      docs.push({
        slug,
        path: `~/.octo-santa/brain/${file}`,
        title: fm?.title ?? slug,
        summary: fm?.summary ?? "",
        tags: fm?.tags ?? [],
      });
    }
    return docs;
  }

  readSharedDoc(slug: string): string {
    const filePath = join(this.sharedBrainDir, `${slug}.md`);
    if (!existsSync(filePath)) throw new Error(`shared brain doc "${slug}" not found`);
    if (escapesParent(this.sharedBrainDir, normalize(filePath))) {
      throw new Error(`slug "${slug}" escapes shared brain directory`);
    }
    return readFileSync(filePath, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFsBrainStore(
  cwd: string,
  brainConfig?: { dirs?: string[]; files?: string[] }
): FsBrainStore {
  return new FsBrainStore(cwd, brainConfig?.dirs, brainConfig?.files);
}
