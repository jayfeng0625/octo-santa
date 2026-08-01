import type { Database } from "bun:sqlite";
import type { AdminStoragePort } from "../../core/ports";
import type {
  AdminValue,
  AdminRow,
  AdminExecuteResult,
  AdminInterfaceDescription,
} from "../../core/admin/types";
import { withRetrySync } from "./db";
import { SQLITE_ADMIN_TYPEHEAD } from "./admin-typehead";

// Elevated admin access to the SQLite database. Admin SQL is one-off dynamic
// text from external apps, so statements go through db.prepare() (uncached,
// finalized after use) rather than db.query()'s per-string cache.
export class SqliteAdminGateway implements AdminStoragePort {
  constructor(private readonly db: Database) {}

  describe(): AdminInterfaceDescription {
    return {
      provider: "sqlite",
      dialect: "sqlite",
      typehead: SQLITE_ADMIN_TYPEHEAD,
    };
  }

  // Reads are free in WAL mode — no transaction, no retry. Read-only is
  // enforced by the connection-level query_only pragma, which makes any
  // mutation attempt fail at step time; safe to toggle because bun:sqlite is
  // synchronous, so nothing else runs on this connection inside the window.
  search(query: string, params: AdminValue[] = []): AdminRow[] {
    this.db.run("PRAGMA query_only = ON");
    try {
      const stmt = this.db.prepare(query);
      try {
        const rows = stmt.all(...params) as Record<string, unknown>[];
        return rows.map(normalizeRow);
      } finally {
        stmt.finalize();
      }
    } finally {
      this.db.run("PRAGMA query_only = OFF");
    }
  }

  execute(statement: string, params: AdminValue[] = []): AdminExecuteResult {
    const doExecute = this.db.transaction(() => {
      const stmt = this.db.prepare(statement);
      try {
        const changes = stmt.run(...params);
        return {
          changes: changes.changes,
          last_insert_row_id: Number(changes.lastInsertRowid),
        };
      } finally {
        stmt.finalize();
      }
    });
    return withRetrySync(() => doExecute.immediate());
  }
}

// SQLite can hand back BLOBs (Uint8Array) and, in principle, bigints; the
// admin plane's wire contract is JSON scalars only.
function normalizeRow(row: Record<string, unknown>): AdminRow {
  const out: AdminRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Uint8Array) {
      out[key] = Buffer.from(value).toString("base64");
    } else if (typeof value === "bigint") {
      out[key] = Number(value);
    } else {
      out[key] = value as AdminValue;
    }
  }
  return out;
}
