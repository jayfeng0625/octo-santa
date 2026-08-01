import type { Database } from "bun:sqlite";
import type { AgentRepository } from "../../core/ports";
import type { Agent, HeartbeatResult } from "../../core/messaging/types";
import { isAgentActive } from "../../core/utils";
import { withRetrySync } from "./db";

export class SqliteAgentRepo implements AgentRepository {
  constructor(private readonly db: Database) {}

  findById(id: string): Agent | null {
    return (this.db.query("SELECT * FROM agents WHERE id = ?").get(id) as Agent) ?? null;
  }

  register(agentId: string, pid: number): Agent {
    const doRegister = this.db.transaction(() => {
      const existing = this.findById(agentId);

      if (existing && existing.pid !== null && existing.pid !== pid) {
        if (isAgentActive(existing)) {
          throw new Error(
            `Agent "${agentId}" is already active (pid ${existing.pid}). Choose a different name.`
          );
        }
      }

      const now = Date.now();
      this.db
        .query(
          `INSERT INTO agents (id, created_at, last_seen_at, pid, registered_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             last_seen_at = excluded.last_seen_at,
             pid = excluded.pid,
             registered_at = excluded.registered_at`
        )
        .run(agentId, now, now, pid, now);
      return this.findById(agentId)!;
    });

    return withRetrySync(() => doRegister.exclusive());
  }

  heartbeatOrReclaim(agentId: string, pid: number): HeartbeatResult {
    const doHeartbeat = this.db.transaction((): HeartbeatResult => {
      const now = Date.now();

      const result = this.db
        .query("UPDATE agents SET last_seen_at = ? WHERE id = ? AND pid = ?")
        .run(now, agentId, pid);

      if (result.changes > 0) return "ok";

      const current = this.findById(agentId);
      if (!current) return "lost";

      if (isAgentActive(current)) {
        return "lost";
      }

      // Current owner is stale — compare-and-swap reclaim against its pid.
      const reclaim = this.db
        .query(
          "UPDATE agents SET pid = ?, registered_at = ?, last_seen_at = ? WHERE id = ? AND pid = ?"
        )
        .run(pid, now, now, agentId, current.pid);

      return reclaim.changes > 0 ? "ok" : "lost";
    });

    return withRetrySync(() => doHeartbeat.exclusive());
  }

  listAll(): Agent[] {
    return this.db
      .query("SELECT * FROM agents WHERE id != '_system' ORDER BY id")
      .all() as Agent[];
  }

  clearPid(id: string, expectedPid: number): void {
    const doClear = this.db.transaction(() => {
      this.db
        .query("UPDATE agents SET pid = NULL, registered_at = NULL WHERE id = ? AND pid = ?")
        .run(id, expectedPid);
    });
    withRetrySync(() => doClear.exclusive());
  }
}
