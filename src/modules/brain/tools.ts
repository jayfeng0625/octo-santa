import { readFileSync, existsSync, readdirSync } from "fs";
import { join, resolve, normalize, relative, isAbsolute, sep } from "path";
import { homedir } from "os";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { Migration } from "../../migrations";
import { withRetrySync } from "../../db";
import { log } from "../../log";
import { isAgentActive } from "../messaging/tools";
import type { Agent } from "../messaging/types";
import type { OctoSantaConfig, BrainDoc, Domain, DomainExpert } from "./types";

// Step 1: Config reading

const ConfigSchema = z.object({
  domain: z.object({
    identifier: z.string().min(1),
    tags: z.array(z.string()),
    description: z.string().min(1),
  }).optional(),
  brain: z.object({
    dirs: z.array(z.string().min(1)),
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

// Step 2: Path sandboxing

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

// Step 3: Frontmatter scanning

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

export function scanBrainDocs(cwd: string, dirs: string[]): BrainDoc[] {
  const docs: BrainDoc[] = [];
  for (const dir of dirs) {
    const absDir = validateBrainDir(cwd, dir);
    if (!existsSync(absDir)) continue;
    const files = readdirSync(absDir).filter(f => f.endsWith(".md")).sort();
    for (const file of files) {
      const content = readFileSync(join(absDir, file), "utf-8");
      const fm = parseFrontmatter(content);
      if (!fm) continue;
      const slug = file.replace(/\.md$/, "");
      docs.push({
        slug,
        path: `./${relative(cwd, join(absDir, file)).replace(/\\/g, "/")}`,
        title: fm.title,
        summary: fm.summary,
        tags: fm.tags,
      });
    }
  }
  return docs;
}

// Step 4: Brain read

export function readBrainDoc(cwd: string, dirs: string[], slug: string): string {
  for (const dir of dirs) {
    const absDir = validateBrainDir(cwd, dir);
    const filePath = join(absDir, `${slug}.md`);
    if (existsSync(filePath)) {
      if (escapesParent(absDir, normalize(filePath))) {
        throw new Error(`slug "${slug}" escapes brain directory`);
      }
      return readFileSync(filePath, "utf-8");
    }
  }
  throw new Error(`brain doc "${slug}" not found`);
}

// Step 5: Shared brain helpers

const SHARED_BRAIN_DIR = join(homedir(), ".octo-santa", "brain");

export function scanSharedBrainDocs(): BrainDoc[] {
  if (!existsSync(SHARED_BRAIN_DIR)) return [];
  const files = readdirSync(SHARED_BRAIN_DIR).filter(f => f.endsWith(".md")).sort();
  const docs: BrainDoc[] = [];
  for (const file of files) {
    const content = readFileSync(join(SHARED_BRAIN_DIR, file), "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm) continue;
    const slug = file.replace(/\.md$/, "");
    docs.push({
      slug,
      path: `~/.octo-santa/brain/${file}`,
      title: fm.title,
      summary: fm.summary,
      tags: fm.tags,
    });
  }
  return docs;
}

export function readSharedBrainDoc(slug: string): string {
  const filePath = join(SHARED_BRAIN_DIR, `${slug}.md`);
  if (!existsSync(filePath)) throw new Error(`shared brain doc "${slug}" not found`);
  if (escapesParent(SHARED_BRAIN_DIR, normalize(filePath))) {
    throw new Error(`slug "${slug}" escapes shared brain directory`);
  }
  return readFileSync(filePath, "utf-8");
}

// Step 6: Domain operations

export function upsertDomain(db: Database, config: OctoSantaConfig, cwd: string): void {
  if (!config.domain) return;
  const { identifier, tags, description } = config.domain;
  withRetrySync(() => {
    db.run(
      `INSERT INTO domains (identifier, cwd, tags, description, registered_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(identifier) DO UPDATE SET cwd = excluded.cwd, tags = excluded.tags, description = excluded.description, registered_at = excluded.registered_at`,
      [identifier, cwd, JSON.stringify(tags), description, Date.now()]
    );
  });
}

export function claimDomain(db: Database, agentId: string, cwd: string, config: OctoSantaConfig | null): void {
  if (!config?.domain) throw new Error("No domain configured for this repo");
  const agent = db.query("SELECT pid FROM agents WHERE id = ? AND pid = ?").get(agentId, process.pid) as { pid: number } | null;
  if (!agent) throw new Error("Must call messaging_register before brain_claim_domain");
  withRetrySync(() => {
    db.run(
      `INSERT INTO domain_claims (agent_id, pid, domain_identifier, claimed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(agent_id, pid) DO UPDATE SET domain_identifier = excluded.domain_identifier, claimed_at = excluded.claimed_at`,
      [agentId, process.pid, config.domain!.identifier, Date.now()]
    );
  });
}

export function findExperts(db: Database): DomainExpert[] {
  const domains = db.query("SELECT * FROM domains ORDER BY identifier").all() as Domain[];
  const claims = db.query(
    `SELECT dc.agent_id, dc.domain_identifier,
            a.id, a.pid, a.created_at, a.last_seen_at, a.registered_at
     FROM domain_claims dc
     JOIN agents a ON dc.agent_id = a.id AND dc.pid = a.pid`
  ).all() as (Agent & { agent_id: string; domain_identifier: string })[];

  return domains.map(d => {
    const domainClaims = claims.filter(c => c.domain_identifier === d.identifier);
    const activeSessions = domainClaims
      .filter(c => isAgentActive(c))
      .map(c => c.agent_id);
    return {
      identifier: d.identifier,
      tags: JSON.parse(d.tags),
      description: d.description,
      active_sessions: activeSessions,
    };
  });
}

// Step 7: Cleanup on disconnect

export function onBrainDisconnect(db: Database, agentId: string, pid: number): void {
  withRetrySync(() => {
    db.run("DELETE FROM domain_claims WHERE agent_id = ? AND pid = ?", [agentId, pid]);
  });
}

// Step 8: Migrations

export const brainMigrations: Migration[] = [
  {
    name: "brain_001_domains_and_claims",
    up: `
      CREATE TABLE domains (
        identifier TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        tags TEXT NOT NULL,
        description TEXT NOT NULL,
        registered_at INTEGER NOT NULL
      );
      CREATE TABLE domain_claims (
        agent_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        domain_identifier TEXT NOT NULL REFERENCES domains(identifier),
        claimed_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, pid)
      );
    `,
  },
];
