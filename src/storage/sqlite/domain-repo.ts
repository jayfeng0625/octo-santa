import type { Database } from "bun:sqlite";
import type { DomainRepository } from "../../core/ports";
import type { DomainWithClaims } from "../../core/brain/types";
import type { Agent } from "../../core/messaging/types";
import { withRetrySync } from "./db";

export class SqliteDomainRepo implements DomainRepository {
  constructor(private db: Database) {}

  register(identifier: string, cwd: string, tags: string[], description: string): void {
    withRetrySync(() => {
      this.db.run(
        `INSERT INTO domains (identifier, cwd, tags, description, registered_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(identifier) DO UPDATE SET cwd = excluded.cwd, tags = excluded.tags, description = excluded.description, registered_at = excluded.registered_at`,
        [identifier, cwd, JSON.stringify(tags), description, Date.now()]
      );
    });
  }

  claim(agentId: string, pid: number, domainIdentifier: string): void {
    withRetrySync(() => {
      this.db.run(
        `INSERT INTO domain_claims (agent_id, pid, domain_identifier, claimed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id, pid) DO UPDATE SET domain_identifier = excluded.domain_identifier, claimed_at = excluded.claimed_at`,
        [agentId, pid, domainIdentifier, Date.now()]
      );
    });
  }

  listWithClaims(): DomainWithClaims[] {
    const domains = this.db.query("SELECT * FROM domains ORDER BY identifier").all() as Array<{
      identifier: string; tags: string; description: string;
    }>;
    const claims = this.db.query(
      `SELECT dc.agent_id, dc.pid, dc.domain_identifier,
              a.id, a.created_at, a.last_seen_at, a.pid as agent_pid, a.registered_at
       FROM domain_claims dc
       JOIN agents a ON dc.agent_id = a.id AND dc.pid = a.pid`
    ).all() as Array<{
      agent_id: string; pid: number; domain_identifier: string;
      id: string; created_at: number; last_seen_at: number; agent_pid: number | null; registered_at: number | null;
    }>;

    return domains.map((d) => ({
      identifier: d.identifier,
      tags: d.tags,
      description: d.description,
      claims: claims.filter((c) => c.domain_identifier === d.identifier).map((c) => ({
        agent_id: c.agent_id,
        pid: c.pid,
        agent: { id: c.id, created_at: c.created_at, last_seen_at: c.last_seen_at, pid: c.agent_pid, registered_at: c.registered_at } as Agent,
      })),
    }));
  }

  clearClaims(agentId: string, pid: number): void {
    withRetrySync(() => {
      this.db.run("DELETE FROM domain_claims WHERE agent_id = ? AND pid = ?", [agentId, pid]);
    });
  }
}
