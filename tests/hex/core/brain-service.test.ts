import { describe, it, expect, afterEach } from "bun:test";
import { BrainService } from "../../../src/core/brain/service";
import { createSqliteRepos } from "../../../src/storage/sqlite";
import { createFsBrainStore } from "../../../src/storage/fs-brain-store/store";
import { createDb } from "../../../src/storage/sqlite/db";
import { runMigrations, allMigrations } from "../../../src/storage/sqlite/migrations";
import { cleanupDb } from "../../helpers/db";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import type { OctoSantaConfig } from "../../../src/core/brain/types";

const TEST_DB = `/tmp/octo-santa-test-hex-brain-svc-${process.pid}.sqlite`;
const TMP_DIR = `/tmp/octo-santa-test-hex-brain-svc-dir-${process.pid}`;

const CONFIG: OctoSantaConfig = {
  domain: { identifier: "my-project", tags: ["ts"], description: "Test project" },
  brain: { dirs: ["brain"] },
};

function setup(configOverride?: OctoSantaConfig | null) {
  cleanupDb(TEST_DB);
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(join(TMP_DIR, "brain"), { recursive: true });
  writeFileSync(
    join(TMP_DIR, "brain", "doc.md"),
    "---\ntitle: Doc\nsummary: A doc\ntags: []\n---\nContent."
  );
  const db = createDb(TEST_DB);
  runMigrations(db, allMigrations);
  const repos = createSqliteRepos(db);
  const cfg = configOverride !== undefined ? configOverride : CONFIG;
  const brainStore = createFsBrainStore(TMP_DIR, cfg?.brain);
  const svc = new BrainService(brainStore, repos.domains, repos.agents, cfg, process.pid);
  return { db, repos, svc };
}

afterEach(() => {
  cleanupDb(TEST_DB);
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

describe("BrainService", () => {
  it("index returns docs from brain directory", () => {
    const { db, svc } = setup();
    const docs = svc.index();
    expect(docs.length).toBe(1);
    expect(docs[0]!.slug).toBe("doc");
    expect(docs[0]!.title).toBe("Doc");
    expect(docs[0]!.summary).toBe("A doc");
    db.close();
  });

  it("read returns file content for a slug", () => {
    const { db, svc } = setup();
    const content = svc.read("doc");
    expect(content).toContain("Content.");
    expect(content).toContain("title: Doc");
    db.close();
  });

  it("read throws for unknown slug", () => {
    const { db, svc } = setup();
    expect(() => svc.read("nonexistent")).toThrow("not found");
    db.close();
  });

  it("registerDomain inserts a domain row", () => {
    const { db, repos, svc } = setup();
    svc.registerDomain("/some/cwd");
    const domains = repos.domains.listWithClaims();
    expect(domains.length).toBe(1);
    expect(domains[0]!.identifier).toBe("my-project");
    db.close();
  });

  it("registerDomain is a no-op when config has no domain", () => {
    const { db, repos, svc } = setup({ brain: { dirs: ["brain"] } });
    svc.registerDomain("/some/cwd");
    const domains = repos.domains.listWithClaims();
    expect(domains.length).toBe(0);
    db.close();
  });

  it("claimDomain requires agent registration first", () => {
    const { db, svc } = setup();
    svc.registerDomain("/some/cwd");
    expect(() => svc.claimDomain("unregistered-agent")).toThrow(
      "Must call messaging_register before brain_claim_domain"
    );
    db.close();
  });

  it("claimDomain succeeds for registered agent", () => {
    const { db, repos, svc } = setup();
    svc.registerDomain("/some/cwd");
    repos.agents.register("test-agent", process.pid);
    svc.claimDomain("test-agent");
    const domains = repos.domains.listWithClaims();
    expect(domains[0]!.claims.length).toBe(1);
    expect(domains[0]!.claims[0]!.agent_id).toBe("test-agent");
    db.close();
  });

  it("claimDomain throws when no domain configured", () => {
    const { db, svc } = setup({ brain: { dirs: ["brain"] } });
    expect(() => svc.claimDomain("test-agent")).toThrow("No domain configured");
    db.close();
  });

  it("findExperts filters dead agents from active_sessions", () => {
    const { db, repos, svc } = setup();
    svc.registerDomain("/some/cwd");
    // Register an agent with current process pid (alive)
    repos.agents.register("alive-agent", process.pid);
    repos.domains.claim("alive-agent", process.pid, "my-project");

    const experts = svc.findExperts();
    expect(experts.length).toBe(1);
    expect(experts[0]!.identifier).toBe("my-project");
    expect(experts[0]!.tags).toEqual(["ts"]);
    expect(experts[0]!.active_sessions).toContain("alive-agent");
    db.close();
  });

  it("findExperts excludes agents with dead pids", () => {
    const { db, repos, svc } = setup();
    svc.registerDomain("/some/cwd");
    // Register agent then give it a dead PID
    repos.agents.register("dead-agent", process.pid);
    repos.domains.claim("dead-agent", process.pid, "my-project");
    // Set agent's pid to something certainly dead
    db.run("UPDATE agents SET pid = 999999 WHERE id = ?", ["dead-agent"]);
    // Update the claim's pid too so the JOIN in listWithClaims still matches
    db.run("UPDATE domain_claims SET pid = 999999 WHERE agent_id = ?", ["dead-agent"]);

    const experts = svc.findExperts();
    expect(experts.length).toBe(1);
    expect(experts[0]!.active_sessions).toEqual([]);
    db.close();
  });

  it("onDisconnect clears domain claims", () => {
    const { db, repos, svc } = setup();
    svc.registerDomain("/some/cwd");
    repos.agents.register("test-agent", process.pid);
    repos.domains.claim("test-agent", process.pid, "my-project");

    svc.onDisconnect("test-agent", process.pid);

    const domains = repos.domains.listWithClaims();
    expect(domains[0]!.claims.length).toBe(0);
    db.close();
  });
});
