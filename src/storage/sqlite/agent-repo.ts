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

  findByBaseName(baseName: string): Agent[] {
    return this.db
      .query("SELECT * FROM agents WHERE base_name = ? ORDER BY id")
      .all(baseName) as Agent[];
  }

  /**
   * Private helper: performs INSERT/ON CONFLICT upsert without wrapping in its own transaction.
   * The caller (register or registerWithProfile) must wrap this in an EXCLUSIVE transaction.
   * When profileFields is omitted, sets base_name/persona/objective to NULL (clears stale data).
   */
  private _upsertAgent(
    agentId: string,
    pid: number,
    profileFields?: { baseName: string; persona: string | null; objective: string | null }
  ): void {
    const now = Date.now();
    if (profileFields) {
      this.db
        .query(
          `INSERT INTO agents (id, created_at, last_seen_at, pid, registered_at, base_name, persona, objective)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             last_seen_at = excluded.last_seen_at,
             pid = excluded.pid,
             registered_at = excluded.registered_at,
             base_name = excluded.base_name,
             persona = excluded.persona,
             objective = excluded.objective`
        )
        .run(agentId, now, now, pid, now, profileFields.baseName, profileFields.persona, profileFields.objective);
    } else {
      this.db
        .query(
          `INSERT INTO agents (id, created_at, last_seen_at, pid, registered_at, base_name, persona, objective)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)
           ON CONFLICT(id) DO UPDATE SET
             last_seen_at = excluded.last_seen_at,
             pid = excluded.pid,
             registered_at = excluded.registered_at,
             base_name = excluded.base_name,
             persona = excluded.persona,
             objective = excluded.objective`
        )
        .run(agentId, now, now, pid, now);
    }
  }

  register(
    agentId: string,
    pid: number,
    profileFields?: { baseName: string; persona: string | null; objective: string | null }
  ): Agent {
    const doRegister = this.db.transaction(() => {
      const existing = this.findById(agentId);

      if (existing && existing.pid !== null && existing.pid !== pid) {
        if (isProcessAlive(existing.pid) && Date.now() - existing.last_seen_at <= PID_STALE_MS) {
          throw new Error(
            `Agent "${agentId}" is already active (pid ${existing.pid}). Choose a different name.`
          );
        }
      }

      this._upsertAgent(agentId, pid, profileFields);
      return this.findById(agentId)!;
    });

    return withRetrySync(() => doRegister.exclusive());
  }

  registerWithProfile(
    baseName: string,
    pid: number,
    maxInstances: number,
    profileFields: { persona: string | null; objective: string | null }
  ): { agent: Agent; registeredName: string; instanceNumber: number | null } {
    const doRegister = this.db.transaction(() => {
      const existing = this.findByBaseName(baseName);

      // Same-PID idempotency: if this PID already owns a slot, return it
      const ownedSlot = existing.find((a) => a.pid === pid);
      if (ownedSlot) {
        const instanceNumber =
          maxInstances === 1 ? null : extractInstanceNumber(ownedSlot.id, baseName);
        return {
          agent: ownedSlot,
          registeredName: ownedSlot.id,
          instanceNumber,
        };
      }

      if (maxInstances === 1) {
        // Singleton: registered name equals base name
        const current = existing[0] ?? null;
        if (current && current.pid !== null && current.pid !== pid) {
          if (isProcessAlive(current.pid) && Date.now() - current.last_seen_at <= PID_STALE_MS) {
            throw new Error(
              `Agent "${baseName}" is already active (pid ${current.pid}). Max instances: 1.`
            );
          }
        }
        this._upsertAgent(baseName, pid, { baseName, ...profileFields });
        const agent = this.findById(baseName)!;
        return { agent, registeredName: baseName, instanceNumber: null };
      }

      // Pool: scan existing slots to find dead ones or next available
      const liveSlots = new Set<number>();
      const deadSlots: Array<{ slot: number; agentId: string }> = [];

      for (const a of existing) {
        const slot = extractInstanceNumber(a.id, baseName);
        if (slot === null) continue;
        const isDead =
          a.pid === null ||
          !isProcessAlive(a.pid) ||
          Date.now() - a.last_seen_at > PID_STALE_MS;
        if (isDead) {
          deadSlots.push({ slot, agentId: a.id });
        } else {
          liveSlots.add(slot);
        }
      }

      // Prefer reclaiming the lowest dead slot; otherwise use next unused slot number
      deadSlots.sort((a, b) => a.slot - b.slot);

      let chosenSlot: number;
      if (deadSlots.length > 0) {
        chosenSlot = deadSlots[0]!.slot;
      } else if (liveSlots.size < maxInstances) {
        chosenSlot = 1;
        while (liveSlots.has(chosenSlot)) chosenSlot++;
      } else {
        const activeList = existing
          .filter((a) => a.pid !== null && isProcessAlive(a.pid) && Date.now() - a.last_seen_at <= PID_STALE_MS)
          .map((a) => `${a.id} (pid ${a.pid})`)
          .join(", ");
        throw new Error(
          `Agent pool "${baseName}" is at capacity (${maxInstances}/${maxInstances} instances). Active instances: ${activeList}`
        );
      }

      const registeredName = `${baseName}-${chosenSlot}`;
      this._upsertAgent(registeredName, pid, { baseName, ...profileFields });
      const agent = this.findById(registeredName)!;
      return { agent, registeredName, instanceNumber: chosenSlot };
    });

    return withRetrySync(() => doRegister.exclusive());
  }

  heartbeatOrReclaim(agentId: string, pid: number): HeartbeatResult {
    const doHeartbeat = this.db.transaction((): HeartbeatResult => {
      const now = Date.now();

      // (1) Try UPDATE WHERE pid=? — happy path heartbeat
      const result = this.db
        .query("UPDATE agents SET last_seen_at = ? WHERE id = ? AND pid = ?")
        .run(now, agentId, pid);

      if (result.changes > 0) return "ok";

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

/**
 * Extracts the numeric slot suffix from a pool agent ID.
 * e.g. extractInstanceNumber("worker-2", "worker") → 2
 * Returns null if the ID doesn't match the expected pool pattern.
 */
function extractInstanceNumber(agentId: string, baseName: string): number | null {
  const prefix = `${baseName}-`;
  if (!agentId.startsWith(prefix)) return null;
  const suffix = agentId.slice(prefix.length);
  const n = parseInt(suffix, 10);
  if (isNaN(n) || n <= 0 || String(n) !== suffix) return null;
  return n;
}
