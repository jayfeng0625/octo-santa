// The SQLite provider's typehead: a complete TypeScript declaration file
// describing how approved external apps interact with octo-santa's database
// through the admin MCP connection's `admin_search` / `admin_execute` tools.
// Served to clients as the `octo-santa://admin/typehead.d.ts` MCP resource.
//
// This is the provider-authored half of the admin contract: core exposes the
// generic search/execute plane; this file defines what those strings mean for
// the SQLite implementation (dialect, table shapes, delivery invariants).
// Keep it in lockstep with `migrations.ts` — the row interfaces below must
// match the live schema, legacy orphaned columns included, because
// `SELECT *` returns them.

export const SQLITE_ADMIN_TYPEHEAD = `\
/**
 * octo-santa admin typehead — SQLite provider.
 *
 * Obtained from the admin MCP server as resource
 * \`octo-santa://admin/typehead.d.ts\`. Describes the elevated access plane
 * exposed by the \`admin_search\` (read-only) and \`admin_execute\` (mutating)
 * MCP tools. Both take raw SQL in the SQLite dialect with positional \`?\`
 * bind parameters.
 *
 * DEPLOYMENT FACTS (violating these breaks delivery):
 * - The database is the only cross-process bridge. Every octo-santa agent
 *   process watches the \`messages\` table (~2s poll) and pushes matching rows
 *   to its agent — so a plain INSERT into \`messages\` IS a delivery. No other
 *   signal is needed or possible.
 * - The DB runs in WAL mode with \`foreign_keys = ON\`. Writes must satisfy
 *   the FK constraints below.
 * - \`admin_search\` runs under \`PRAGMA query_only\` — any statement that
 *   mutates state fails. \`admin_execute\` runs one statement inside an
 *   immediate transaction with busy-retry.
 * - Message ids are monotonic. Timestamps are Unix epoch milliseconds.
 */
declare module "octo-santa/admin" {
  /** Scalar values accepted as bind parameters and returned in row cells. */
  export type AdminValue = string | number | boolean | null;

  // ── Tables ────────────────────────────────────────────────────────────────

  /** \`agents\` — one row per known agent. \`_system\` is a seeded sender usable by external apps. */
  export interface AgentRow {
    id: string;
    /** Unix ms of first registration. */
    created_at: number;
    /** Unix ms of last heartbeat; liveness = within the last 30s and pid alive. */
    last_seen_at: number;
    /** Owning process id; null when disconnected. */
    pid: number | null;
    /** Unix ms of current registration; null when disconnected. */
    registered_at: number | null;
    /** @deprecated legacy, orphaned */
    base_name: string | null;
    /** @deprecated legacy, orphaned */
    persona: string | null;
    /** @deprecated legacy, orphaned */
    objective: string | null;
    /** @deprecated legacy, orphaned */
    instructions: string | null;
  }

  /**
   * \`channels\` — named channels. DM channels are named
   * \`"<agentA>,<agentB>"\` (both names sorted, comma-joined).
   */
  export interface ChannelRow {
    id: number;
    /** Unique. Allowed chars: letters, digits, and \`_-.,@#\`. */
    name: string;
    /** FK → agents.id */
    created_by: string;
    created_at: number;
    /** @deprecated legacy, orphaned */
    max_hops: number;
    /** @deprecated legacy, orphaned */
    hop_count: number;
  }

  /**
   * \`messages\` — append-only message log. Inserting a row delivers it:
   * each agent's server process picks it up from here and pushes it.
   */
  export interface MessageRow {
    /** Monotonic; usable as a cursor. */
    id: number;
    /** FK → channels.id */
    channel_id: number;
    /** Sender. FK → agents.id — the row must exist (use \`_system\` or insert your app's agent first). */
    agent_id: string;
    content: string;
    created_at: number;
    /**
     * JSON array of mentioned agent names, e.g. \`'["planner"]'\` or \`'["*"]'\`
     * (\`*\` = @all). Push notification targeting reads THIS column, not
     * \`content\`: regular channels notify only mentioned live agents; DM
     * channels notify both parties regardless. \`'[]'\` = silent (poll-only).
     */
    mentions: string;
  }

  /** \`cursors\` — per-(agent, channel) read position. PK (agent_id, channel_id). A row here is also what makes an agent a channel member. */
  export interface CursorRow {
    agent_id: string;
    channel_id: number;
    /** Last consumed messages.id; 0 = nothing read. */
    last_read_message_id: number;
  }

  /** \`schema_migrations\` — applied migration ledger. Do not modify. */
  export interface SchemaMigrationRow {
    name: string;
    checksum: string;
    applied_at: number;
  }

  /** @deprecated legacy, orphaned */
  export interface DomainRow {
    identifier: string;
    cwd: string;
    tags: string;
    description: string;
    registered_at: number;
  }

  /** @deprecated legacy, orphaned */
  export interface DomainClaimRow {
    agent_id: string;
    pid: number;
    domain_identifier: string;
    claimed_at: number;
  }

  /** Table name → row shape, as returned by \`SELECT *\`. */
  export interface Tables {
    agents: AgentRow;
    channels: ChannelRow;
    messages: MessageRow;
    cursors: CursorRow;
    schema_migrations: SchemaMigrationRow;
    /** @deprecated */ domains: DomainRow;
    /** @deprecated */ domain_claims: DomainClaimRow;
  }

  // ── Tool contracts ────────────────────────────────────────────────────────

  export interface AdminSearchInput {
    /** Read-only SQLite SQL (SELECT / WITH / EXPLAIN). Mutations are rejected. */
    query: string;
    /** Positional bindings for \`?\` placeholders. */
    params?: AdminValue[];
  }

  export interface AdminSearchResult {
    /** BLOB cells are returned base64-encoded. */
    rows: Record<string, AdminValue>[];
    row_count: number;
    /** True when rows were capped at the server's max row count. */
    truncated: boolean;
  }

  export interface AdminExecuteInput {
    /** Exactly one mutating SQLite statement; runs atomically. No BEGIN/COMMIT — the server wraps it. */
    statement: string;
    params?: AdminValue[];
  }

  export interface AdminExecuteResult {
    changes: number;
    last_insert_row_id: number;
  }

  /**
   * The admin plane, as seen through any MCP client:
   * call tool \`admin_search\` / \`admin_execute\` on the octo-santa-admin server.
   *
   * @example Deliver an issue-tracker event to a channel (external agent loop):
   *   // 1. Ensure your app exists as a sender (or just use '_system'):
   *   execute("INSERT OR IGNORE INTO agents (id, created_at, last_seen_at) VALUES (?, ?, ?)",
   *           ["linear-hook", Date.now(), Date.now()])
   *   // 2. Find the target channel:
   *   search("SELECT id FROM channels WHERE name = ?", ["eng-triage"])
   *   // 3. Insert = deliver. Mention '["*"]' to push to every live member:
   *   execute("INSERT INTO messages (channel_id, agent_id, content, created_at, mentions) VALUES (?, ?, ?, ?, ?)",
   *           [7, "linear-hook", "LIN-142 moved to In Review", Date.now(), '["*"]'])
   *
   * @example OLAP over message traffic:
   *   search("SELECT agent_id, COUNT(*) AS sent, DATE(created_at / 1000, 'unixepoch') AS day
   *           FROM messages GROUP BY agent_id, day ORDER BY day DESC")
   */
  export interface OctoSantaAdmin {
    search(input: AdminSearchInput): AdminSearchResult;
    execute(input: AdminExecuteInput): AdminExecuteResult;
  }
}
`;
