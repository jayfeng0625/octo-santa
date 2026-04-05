import type { Database } from "bun:sqlite";
import type { AgentRepository } from "../../core/ports";
import type { Agent, HeartbeatResult } from "../../core/messaging/types";
import { isProcessAlive, PID_STALE_MS } from "../../core/utils";
import { withRetrySync } from "./db";

export class SqliteAgentRepo implements AgentRepository {
  constructor(private readonly db: Database) {}

  findById(id: string): Agent | null {
    return (this.db.query("SELECT * FROM agents WHERE id = ?").get(id) as Agent) ?? null;
  }

  register(agentId: string, pid: number): Agent {
    const doRegister = this.db.transaction(() => {
      const now = Date.now();
      const existing = this.findById(agentId);

      if (existing && existing.pid !== null && existing.pid !== pid) {
        if (isProcessAlive(existing.pid) && Date.now() - existing.last_seen_at <= PID_STALE_MS) {
          throw new Error(
            `Agent "${agentId}" is already active (pid ${existing.pid}). Choose a different name.`
          );
        }
      }

      this.db.run(
        `INSERT INTO agents (id, created_at, last_seen_at, pid, registered_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at, pid = excluded.pid, registered_at = excluded.registered_at`,
        [agentId, now, now, pid, now]
      );

      return this.findById(agentId)!;
    });

    return withRetrySync(() => doRegister.exclusive());
  }

  heartbeatOrReclaim(agentId: string, pid: number): HeartbeatResult {
    const doHeartbeat = this.db.transaction((): HeartbeatResult => {
      const now = Date.now();

      // (1) Try UPDATE WHERE pid=? — happy path heartbeat
      const result = this.db.run(
        "UPDATE agents SET last_seen_at = ? WHERE id = ? AND pid = ?",
        [now, agentId, pid]
      );

      if (result.changes > 0) {
        return "ok";
      }

      // (2) 0 rows updated — check current owner
      const current = this.findById(agentId);
      if (!current) return "lost";

      // If current owner is alive, we lost the agent
      if (
        current.pid !== null &&
        isProcessAlive(current.pid) &&
        Date.now() - current.last_seen_at <= PID_STALE_MS
      ) {
        return "lost";
      }

      // (3) Current owner is stale — CAS reclaim
      const reclaim = this.db.run(
        "UPDATE agents SET pid = ?, registered_at = ?, last_seen_at = ? WHERE id = ? AND pid = ?",
        [pid, now, now, agentId, current.pid]
      );

      return reclaim.changes > 0 ? "ok" : "lost";
    });

    return withRetrySync(() => doHeartbeat.exclusive());
  }

  listAll(): Agent[] {
    return this.db.query("SELECT * FROM agents WHERE id != '_system' ORDER BY id").all() as Agent[];
  }

  clearPid(id: string, expectedPid: number): void {
    withRetrySync(() => {
      this.db.run(
        "UPDATE agents SET pid = NULL, registered_at = NULL WHERE id = ? AND pid = ?",
        [id, expectedPid]
      );
    });
  }
}
