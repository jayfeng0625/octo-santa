# SQLite Concurrency at Scale — Lessons and Design Guidance

> Status: Reference
> Related: messaging module design, brain module, flaky concurrency test fix (PR #4)

## Context

While fixing a flaky concurrency test (PR #4), we uncovered and validated several important properties of SQLite's concurrency model that should inform all future module design in octo-santa — particularly the brain module, which adds read-heavy workloads alongside messaging's write-heavy patterns.

This document captures the findings, compares with Cloudflare D1's approach (SQLite at cloud scale), and provides concrete guidance for designing modules that share the same SQLite database.

## The Single-Writer Reality

**SQLite allows exactly one writer at a time.** This is not a limitation we can work around — it's fundamental to how SQLite operates. WAL mode improves concurrency by allowing readers to run alongside a writer, but two concurrent writes are never possible.

### What we learned from the flaky test

The concurrency test spawns 5 processes, each sending 20 messages through `sendMessage`. The original code used **deferred transactions** (`db.transaction()`), which:

1. Start with a SHARED lock (read-only)
2. Upgrade to EXCLUSIVE when the first write occurs
3. **Deadlock** when two processes both hold SHARED and both try to upgrade

This isn't a retry budget problem or a timeout problem — it's a **structural deadlock** that `busy_timeout` cannot resolve, because neither process will release its SHARED lock voluntarily.

### The fix: immediate transactions

Switching write-path transactions to `.immediate()` solves this by acquiring a RESERVED lock at `BEGIN IMMEDIATE`, before any reads. Only one process can hold RESERVED at a time. Others queue via `busy_timeout` (5000ms), which works correctly here because the lock holder WILL release.

**Key insight: `.immediate()` doesn't reduce concurrency.** SQLite is single-writer regardless. Immediate transactions just make the serialization explicit and deadlock-free.

### Jitter prevents thundering herds

Adding `Math.random() * baseDelayMs` jitter to `withRetrySync` prevents multiple processes from retrying at the same wall-clock instant. Without jitter, deterministic exponential backoff (100ms → 200ms → 400ms) causes synchronized retry storms.

## How Cloudflare D1 Handles This

D1 is SQLite deployed at global scale. Their approach validates our architecture:

> "Each individual D1 database is inherently single-threaded, and processes queries one at a time."

D1 doesn't fight the single-writer constraint — it **removes the lock layer entirely** and queues at the application level via a Durable Object. All writes serialize through a single thread. If the queue fills, clients get an `overloaded` error.

### D1's scaling strategy

| Dimension | D1's approach | octo-santa equivalent |
|-----------|--------------|----------------------|
| **Write throughput** | Single-threaded queue. ~1000 qps at 1ms/query. For more: shard across multiple DBs | Same — single writer, shard by DB if needed |
| **Read throughput** | Global read replicas near each edge location | N/A (local-only), but reads don't block writes in WAL |
| **Consistency** | Sequential consistency via Sessions API + bookmarks | Cursor-based reads provide similar per-agent consistency |
| **Write contention** | Impossible (serialized queue) | `busy_timeout` + `.immediate()` + jitter |

### Key takeaway

D1 proves that SQLite's single-writer model scales to production — the trick is **not fighting it**. Accept serialized writes, optimize write transactions to be fast, and scale reads separately.

## Design Rules for octo-santa Modules

Based on these findings, all modules sharing the SQLite database should follow these rules:

### 1. Write transactions MUST use `.immediate()` or `.exclusive()`

Never use the default deferred `db.transaction()` for transactions that write. Deferred transactions create SHARED→EXCLUSIVE upgrade deadlocks under multi-process contention.

```typescript
// WRONG — deferred transaction, deadlocks under contention
const doWrite = db.transaction(() => { /* read then write */ });
return withRetrySync(() => doWrite());

// RIGHT — immediate transaction, acquires write lock upfront
const doWrite = db.transaction(() => { /* read then write */ });
return withRetrySync(() => doWrite.immediate());

// ALSO RIGHT — exclusive, for operations that need full isolation
const doMigrate = db.transaction(() => { /* DDL + DML */ });
return withRetrySync(() => doMigrate.exclusive());
```

**When to use which:**
- `.immediate()` — any transaction that reads then writes (most common)
- `.exclusive()` — migrations, schema changes, operations requiring no concurrent readers
- `.deferred()` (default) — read-only transactions only

### 2. Keep write transactions as short as possible

Since only one writer can operate at a time, long write transactions block all other writers. The throughput equation is simple:

```
max_write_qps ≈ 1000 / avg_write_transaction_ms
```

Guidelines:
- Do expensive computation OUTSIDE the transaction
- Avoid network calls or I/O inside write transactions
- Batch multiple related writes into a single transaction (fewer lock acquisitions)
- For the brain module: frontmatter parsing and index building should happen outside any transaction

### 3. Reads are free (in WAL mode) — use them liberally

WAL mode means readers never block writers and writers never block readers. Read-heavy modules like the brain module can query aggressively without impacting write throughput.

```typescript
// This is fine — read-only queries don't need transactions or retries
const docs = db.query("SELECT title, summary FROM brain_docs WHERE domain = ?").all(domain);
```

### 4. Always use `withRetrySync` with jitter for write operations

The retry function handles transient `SQLITE_BUSY` errors that occur when another process holds the write lock:

```typescript
// withRetrySync already includes jitter (added in PR #4)
return withRetrySync(() => doWrite.immediate());
```

Default budget (3 retries, 100ms base) is sufficient for our scale. If a specific path needs more, pass explicit values rather than changing the global default.

### 5. Sharding is a future concern — strategy TBD

The current single-DB architecture is correct for the current scale. If
write throughput becomes a bottleneck (~10+ concurrent writing agents),
the DB will need to be split. The right sharding boundary depends on
where the actual contention is, which we don't know yet.

**What we do know:**
- The write hot path is messaging: `sendMessage` (message insert + cursor
  upsert). Brain adds essentially zero hot-path writes.
- The messaging refactor (Phase 3) further reduces hot-path writes by
  removing `ensureAgent` upserts from send/read.
- Cross-entity queries exist (`messaging_list_channels`,
  `messaging_list_agents`, `brain_find_expert`) — any sharding strategy
  must account for these or accept the cost of cross-DB reads.

**Most likely first step: module-level separation.** Brain and messaging
have zero shared queries at the tool level. The only cross-module
dependency is `brain_claim_domain` validating against the agents table,
which could be a cross-DB read. This is the simplest split with the
cleanest boundary.

**Beyond that: measure first, then decide.** Per-channel DBs sound
appealing but break cross-channel queries and require a coordinator DB
for metadata. The right answer depends on the actual bottleneck — high
message volume in a few channels vs. many channels with moderate volume
are different problems with different solutions.

## Implications for the Brain Module

The brain module adds almost no DB write pressure. Most brain tools are
filesystem reads (scanning directories, reading markdown files) — not DB
operations.

| Operation | Type | Where | Concurrency impact |
|-----------|------|-------|--------------------|
| `brain_index` | Filesystem read | Scans `brain.dirs`, reads YAML frontmatter | None — no DB involved |
| `brain_read` | Filesystem read | Reads markdown file by slug | None — no DB involved |
| `brain_shared_index` | Filesystem read | Scans `~/.octo-santa/brain/` | None — no DB involved |
| `brain_shared_read` | Filesystem read | Reads markdown file by slug | None — no DB involved |
| `brain_find_expert` | DB read | Queries `domains` + `domain_claims` | None — WAL allows concurrent reads |
| Domain auto-registration | DB write (once) | Single UPSERT on startup | Brief — once per server lifecycle |
| `brain_claim_domain` | DB write (once) | Single INSERT per session | Brief — once per session |
| `onDisconnect` unclaim | DB write (once) | Single DELETE on session close | Brief — once per session |

The brain module's DB footprint is essentially zero hot-path writes. The
main risk is startup thundering herd — if 5 agents start simultaneously
and all try to auto-register their domain — but `.immediate()` +
`withRetrySync` + jitter handles this cleanly.

## Implications of the Messaging Refactor

The messaging improvements spec (Phase 3: remove `ensureAgent`) improves
the scaling picture. Currently, `ensureAgent` performs an upsert on every
send/read — a write in the hot path. After Phase 3:

- Send/read validate a PID-bound row exists (a **read**, not a write)
- The only agent-row write is `messaging_register`, once per session
- Implicit `createChannel` inside `sendMessage` is also removed

This reduces hot-path write pressure, giving more headroom before the
~10 concurrent writer threshold becomes relevant. The refactor moves in
the direction this document advocates: fewer implicit writes, shorter
write transactions, reads instead of writes where possible.

## Summary

| Principle | Rationale |
|-----------|-----------|
| SQLite is single-writer by design | Don't fight it — accept and optimize |
| Use `.immediate()` for write transactions | Prevents SHARED→EXCLUSIVE deadlocks |
| Add jitter to retries | Prevents synchronized retry storms |
| Keep write transactions short | Directly determines max write throughput |
| Reads are free in WAL mode | Design read-heavy modules without worry |
| Shard when writes become the bottleneck | Measure first — module-level split is the most likely first step |
| D1 validates this architecture | Production SQLite at scale uses the same model |
