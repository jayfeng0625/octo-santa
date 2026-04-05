import { describe, it, expect, afterEach } from "bun:test";
import { SqliteDomainRepo } from "../../../src/storage/sqlite/domain-repo";
import { SqliteAgentRepo } from "../../../src/storage/sqlite/agent-repo";
import { createDb } from "../../../src/storage/sqlite/db";
import { runMigrations, allMigrations } from "../../../src/storage/sqlite/migrations";
import { cleanupDb } from "../../helpers/db";

const TEST_DB = `/tmp/octo-santa-test-hex-domain-repo-${process.pid}.sqlite`;

function setup() {
  cleanupDb(TEST_DB);
  const db = createDb(TEST_DB);
  runMigrations(db, allMigrations);
  const agents = new SqliteAgentRepo(db);
  const domains = new SqliteDomainRepo(db);
  return { db, agents, domains };
}

afterEach(() => cleanupDb(TEST_DB));

describe("SqliteDomainRepo", () => {
  it("register inserts domain row", () => {
    const { db, domains } = setup();
    domains.register("my-project", "/some/cwd", ["ts", "api"], "My project");
    const row = db.query("SELECT * FROM domains WHERE identifier = ?").get("my-project") as any;
    expect(row).not.toBeNull();
    expect(row.description).toBe("My project");
    db.close();
  });

  it("register is idempotent (upserts)", () => {
    const { db, domains } = setup();
    domains.register("my-project", "/cwd1", ["ts"], "desc1");
    domains.register("my-project", "/cwd2", ["ts"], "desc2");
    const row = db.query("SELECT cwd FROM domains WHERE identifier = ?").get("my-project") as any;
    expect(row.cwd).toBe("/cwd2");
    db.close();
  });

  it("claim inserts domain claim", () => {
    const { db, agents, domains } = setup();
    domains.register("my-project", "/cwd", ["ts"], "desc");
    agents.register("test-agent", process.pid);
    domains.claim("test-agent", process.pid, "my-project");
    const claim = db.query("SELECT * FROM domain_claims WHERE agent_id = ?").get("test-agent") as any;
    expect(claim).not.toBeNull();
    expect(claim.domain_identifier).toBe("my-project");
    db.close();
  });

  it("listWithClaims returns domains with agent data", () => {
    const { db, agents, domains } = setup();
    domains.register("my-project", "/cwd", ["ts"], "desc");
    agents.register("expert", process.pid);
    domains.claim("expert", process.pid, "my-project");
    const list = domains.listWithClaims();
    expect(list.length).toBe(1);
    expect(list[0]!.claims.length).toBe(1);
    expect(list[0]!.claims[0]!.agent_id).toBe("expert");
    db.close();
  });

  it("clearClaims removes claims for agent+pid", () => {
    const { db, agents, domains } = setup();
    domains.register("my-project", "/cwd", ["ts"], "desc");
    agents.register("test-agent", process.pid);
    domains.claim("test-agent", process.pid, "my-project");
    domains.clearClaims("test-agent", process.pid);
    const count = db.query("SELECT COUNT(*) as count FROM domain_claims WHERE agent_id = ?").get("test-agent") as any;
    expect(count.count).toBe(0);
    db.close();
  });
});
