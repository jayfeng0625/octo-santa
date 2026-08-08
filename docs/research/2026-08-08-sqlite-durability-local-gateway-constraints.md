# SQLite Durability and Local Gateway Process Constraints

**Research question:** [GitHub issue #51](https://github.com/jayfeng0625/octo-santa/issues/51), "Research SQLite durability and local gateway process constraints"

**Date:** 2026-08-08

**Scope:** Primary SQLite documentation/source, primary Bun documentation/source where the runtime wrapper matters, and the repository at `e99988029ab01191a02bf0144e0dee58916a9aae`. This document establishes constraints; it does not select or implement a topology.

## Executive answer

SQLite does not require a central writer process. It supports independent local processes opening the same database and WAL permits readers to coexist with a writer, but the WAL write lock still admits only one writer at a time. A central daemon, federated processes, and a dual-plane transition therefore differ in queueing, failure ownership, and lifecycle, not in SQLite's fundamental write concurrency.

The current system is a federated design: `main`, `admin`, and even the nominally read-only `poll` entry point each open one connection, set per-connection policy, and run migrations before serving. The one-connection-per-process rule is a repository policy, not a SQLite requirement. It is nevertheless a safe fit for the installed SQLite build, which reports `THREADSAFE=2`: separate connections may be used concurrently, but one connection must not be used concurrently from multiple threads.

`synchronous=NORMAL` in WAL mode is a consistency-safe performance choice, not a promise that every acknowledged commit survives host crash or power loss. WAL commits are not synced individually at `NORMAL`; sync barriers occur in checkpoint work. `FULL` adds the per-commit WAL sync. An application-process crash is a different boundary from host/power failure: a local Bun 1.3.14 probe recovered an acknowledged row after both `SIGTERM` and `SIGKILL`, but that only demonstrates WAL recovery while the OS remained alive.

The current migration transaction correctly serializes writers and atomically records schema changes. However, `BEGIN EXCLUSIVE` does **not** exclude readers in WAL mode. The existing statement that `.exclusive()` is for operations "requiring no concurrent readers" is refuted. Compatibility between live old-schema readers and a migrating process is therefore a product/protocol concern, not something the current lock proves.

Do not implement backup by copying `messages.db` or by assuming Bun's `Database.serialize()` is an online-backup API. An active WAL database's `-wal` file can contain committed state absent from the main file. SQLite's online backup API and `VACUUM INTO` are supported upstream approaches, but the installed Bun 1.3.14 `bun:sqlite` surface exposes neither a backup method nor `node:sqlite`; the exact backup mechanism remains a product and runtime-version choice that needs a restore-tested prototype.

## Evidence method and runtime

The local evidence was read from the isolated worktree at commit `e999880`. Narrow runtime probes were used only where Bun wrapper behavior could not be established from repository code.

| Item | Verified value |
|---|---|
| Local Bun executable | `1.3.14` |
| SQLite returned by `select sqlite_version()` | `3.51.0` |
| Relevant compile options | `THREADSAFE=2`, `DEFAULT_WAL_AUTOCHECKPOINT=1000`, `DEFAULT_WAL_SYNCHRONOUS=1`, `DEFAULT_SYNCHRONOUS=2` |
| `bun:sqlite` database methods | `close`, `exec`, `fileControl`, `prepare`, `query`, `run`, `serialize`, `transaction`, plus cache/handle properties; no `backup` |
| `node:sqlite` in this executable | Import failed to resolve |
| Repository runtime pin | None; `package.json` uses `@types/bun: latest` and declares no Bun engine/version (`package.json:13-18`) |

The Bun documentation/source references below are pinned to Git commit [`6089d0e`](https://github.com/oven-sh/bun/tree/6089d0e83fa297474232eec15dd8915a245d66af). That snapshot is useful primary evidence for Bun's API and current implementation, but it is not treated as proof that every implementation detail exists in the locally installed 1.3.14 binary. Local probe results are identified separately.

## Verified database and runtime facts

### WAL concurrency and files

1. WAL permits concurrent snapshots and one writer. Each reader sees an unchanging snapshot from the point its read transaction starts, while WAL's write-lock admits only one writer. SQLite source states "Only one writer allowed at a time" in [`src/wal.c:3721-3728`](https://github.com/sqlite/sqlite/blob/e0725b0a4fce7dca682250f6c5636cb33f15db89/src/wal.c#L3721-L3728). Snapshot behavior is specified by the [SQLite WAL documentation](https://sqlite.org/wal.html) and [`src/sqlite.h.in:11010-11017`](https://github.com/sqlite/sqlite/blob/e0725b0a4fce7dca682250f6c5636cb33f15db89/src/sqlite.h.in#L11010-L11017).
2. "Readers do not block writers" does not mean readers are free. A long-lived reader can prevent a checkpoint from backfilling frames it may still need; SQLite explicitly refuses to overwrite pages in use by a concurrent reader ([`src/wal.c:2168-2174`](https://github.com/sqlite/sqlite/blob/e0725b0a4fce7dca682250f6c5636cb33f15db89/src/wal.c#L2168-L2174)). The writer can continue appending, so the consequence is checkpoint incompleteness and WAL growth rather than ordinary read/write lock exclusion.
3. WAL requires shared-memory coordination. Upstream SQLite does not support WAL on a network filesystem because all users must share the wal-index; the default Unix/Windows implementation maps it through the `-shm` file ([`src/wal.c:124-140`](https://github.com/sqlite/sqlite/blob/e0725b0a4fce7dca682250f6c5636cb33f15db89/src/wal.c#L124-L140)). The topologies in issue #51 are therefore constrained to processes using a genuinely local filesystem with working SQLite locks/shared memory.
4. The WAL and shared-memory sidecars are part of the live database state. Upstream normally checkpoints and deletes them when the last connection closes unless checkpoint-on-close or WAL persistence changes that behavior ([`src/sqlite.h.in:2410-2424`](https://github.com/sqlite/sqlite/blob/e0725b0a4fce7dca682250f6c5636cb33f15db89/src/sqlite.h.in#L2410-L2424), [`src/sqlite.h.in:976-990`](https://github.com/sqlite/sqlite/blob/e0725b0a4fce7dca682250f6c5636cb33f15db89/src/sqlite.h.in#L976-L990)). Bun documents a platform distinction: macOS uses Apple's SQLite with persistent WAL, so `-wal` and `-shm` remain after close; Linux/Windows usually remove them ([Bun SQLite docs, WAL sidecar cleanup](https://github.com/oven-sh/bun/blob/6089d0e83fa297474232eec15dd8915a245d66af/docs/runtime/sqlite.mdx#L217-L251)).
5. WAL mode is persistent database state, whereas `synchronous`, `busy_timeout`, and `foreign_keys` are connection policy. The current application deliberately reapplies all four when each connection opens (`src/storage/sqlite/db.ts:52-67`).

### Checkpoint behavior

1. Every new SQLite connection has automatic checkpointing enabled at 1,000 WAL frames unless the build changes `SQLITE_DEFAULT_WAL_AUTOCHECKPOINT`. It runs after a commit crosses the threshold and uses `PASSIVE` mode ([`src/sqlite.h.in:10083-10113`](https://github.com/sqlite/sqlite/blob/e0725b0a4fce7dca682250f6c5636cb33f15db89/src/sqlite.h.in#L10083-L10113)). The local compile options confirm the default is 1,000.
2. A passive checkpoint copies as many frames as possible without waiting for readers or writers. It never invokes the busy handler and may finish only partially ([`src/sqlite.h.in:10147-10153`](https://github.com/sqlite/sqlite/blob/e0725b0a4fce7dca682250f6c5636cb33f15db89/src/sqlite.h.in#L10147-L10153)). Therefore `busy_timeout=5000` does not make automatic checkpoint completion inevitable.
3. `FULL`, `RESTART`, and `TRUNCATE` checkpoints wait through the connection's busy handler for writers/readers. `RESTART` additionally waits until readers no longer need the WAL; `TRUNCATE` also reduces the file to zero bytes ([`src/sqlite.h.in:10155-10175`](https://github.com/sqlite/sqlite/blob/e0725b0a4fce7dca682250f6c5636cb33f15db89/src/sqlite.h.in#L10155-L10175)). A concurrent checkpointer can still cause immediate `SQLITE_BUSY` without invoking the busy handler ([`src/sqlite.h.in:10193-10207`](https://github.com/sqlite/sqlite/blob/e0725b0a4fce7dca682250f6c5636cb33f15db89/src/sqlite.h.in#L10193-L10207)).
4. At `synchronous=NORMAL`, checkpoint work is where SQLite issues its WAL/database sync barriers. SQLite syncs the WAL before copying pages to the main file, and syncs the main file only after all WAL content is copied ([`src/wal.c:2176-2188`](https://github.com/sqlite/sqlite/blob/e0725b0a4fce7dca682250f6c5636cb33f15db89/src/wal.c#L2176-L2188)). With automatic checkpoints, whichever writer crosses the threshold can pay that checkpoint/fsync latency.
5. The current application does not configure `wal_autocheckpoint` and has no steady-state checkpoint owner. It therefore inherits per-connection passive checkpoints at 1,000 frames (`src/storage/sqlite/db.ts:52-67`).

### `synchronous=NORMAL` versus `FULL`

The relevant distinction in WAL is **when** the VFS sync primitive is called, not whether a platform's individual sync call uses a constant named `NORMAL` or `FULL`. SQLite source explicitly warns not to conflate those concepts ([`src/pager.c:3655-3664`](https://github.com/sqlite/sqlite/blob/e0725b0a4fce7dca682250f6c5636cb33f15db89/src/pager.c#L3655-L3664)). See also [PRAGMA synchronous](https://sqlite.org/pragma.html#pragma_synchronous).

| Mode in WAL | Commit boundary | Verified consequence |
|---|---|---|
| `NORMAL` | A transaction commit is not individually synced (`src/pager.c` states this directly at [`611-617`](https://github.com/sqlite/sqlite/blob/e0725b0a4fce7dca682250f6c5636cb33f15db89/src/pager.c#L611-L617)); syncs happen during checkpoints. | Database consistency remains protected, and an application crash normally leaves the OS cache available, but one or more recently acknowledged commits may roll back after OS crash, hard reset, or power loss before the relevant sync. |
| `FULL` | SQLite syncs the WAL on each transaction commit before reporting success, in addition to checkpoint sync work. | Stronger durability for acknowledged commits across host/power failure, subject to the VFS, filesystem, storage device, and power-loss behavior honoring sync correctly. Higher and more variable commit latency is expected and must be measured on target hardware. |

Checkpointing is not the same as committing. A committed transaction remains readable/recoverable from a valid WAL without first being copied into the main database file. Conversely, at `NORMAL`, checkpoint scheduling does not retroactively make the latest commit power-loss durable until SQLite performs the required sync barrier.

### Busy handling and transaction acquisition

1. A busy handler is connection-local and only one may be installed. `sqlite3_busy_timeout` sleeps/retries until its accumulated sleep reaches the configured duration, then returns `SQLITE_BUSY` ([`src/sqlite.h.in:3066-3087`](https://github.com/sqlite/sqlite/blob/e0725b0a4fce7dca682250f6c5636cb33f15db89/src/sqlite.h.in#L3066-L3087)).
2. A timeout is not a guarantee that SQLite waits. SQLite can return `SQLITE_BUSY` immediately when invoking the handler could deadlock, especially when a transaction holding a read lock attempts to upgrade while another connection already owns the write reservation ([`src/sqlite.h.in:3032-3046`](https://github.com/sqlite/sqlite/blob/e0725b0a4fce7dca682250f6c5636cb33f15db89/src/sqlite.h.in#L3032-L3046), [`src/btree.c:3614-3626`](https://github.com/sqlite/sqlite/blob/e0725b0a4fce7dca682250f6c5636cb33f15db89/src/btree.c#L3614-L3626)). This validates acquiring the write transaction before application reads when the operation will write.
3. The application sets a 5-second SQLite busy timeout and then wraps writes in an outer synchronous exponential retry with jitter (`src/storage/sqlite/db.ts:16-46,57-64`). These waits compose. A default operation can make four SQLite attempts, each potentially consuming the 5-second timeout, plus roughly 0.7-1.0 seconds of application sleep. The current configuration can therefore approach 21 seconds before failing, although immediate-deadlock and checkpoint-lock cases may return sooner.
4. The outer retry identifies busy conditions by lowercased message substrings (`"database is locked"` or `"sqlite_busy"`) and does not retry `SQLITE_LOCKED` (`src/storage/sqlite/db.ts:16-21`). Whether that classification is sufficient for backup, schema changes, and all target-platform Bun error shapes is unverified.
5. Bun's SQLite API is synchronous ([Bun SQLite docs](https://bun.sh/docs/runtime/sqlite)); `withRetrySync` uses `Bun.sleepSync` (`src/storage/sqlite/db.ts:24-45`). In a central gateway, one contended write therefore blocks that process's JavaScript event loop unless writes are isolated behind another process/thread or the gateway deliberately accepts that head-of-line blocking.

### Connections and process boundaries

1. SQLite supports multiple connections and multiple local processes. One connection per process is not a database requirement. It is an octo-santa convention documented in `CLAUDE.md` and implemented by each composition root creating one `Database`, then sharing it across repositories (`src/main.ts:10-22`, `src/admin.ts:12-20`, `src/poll.ts:70-76`).
2. The installed SQLite reports `THREADSAFE=2`. SQLite defines multi-thread mode as safe for concurrent use of separate connections, while requiring the application to serialize access to any one connection ([`src/sqlite.h.in:1868-1880`](https://github.com/sqlite/sqlite/blob/e0725b0a4fce7dca682250f6c5636cb33f15db89/src/sqlite.h.in#L1868-L1880)). Bun opens `bun:sqlite` with SQLite's default flags, without explicitly adding `FULLMUTEX` ([default flags](https://github.com/oven-sh/bun/blob/6089d0e83fa297474232eec15dd8915a245d66af/src/jsc/bindings/sqlite/JSSQLStatement.cpp#L161-L162), [open call](https://github.com/oven-sh/bun/blob/6089d0e83fa297474232eec15dd8915a245d66af/src/jsc/bindings/sqlite/JSSQLStatement.cpp#L1777-L1799)). Do not hand the current connection to concurrent Bun workers without a separate proof or serialization layer.
3. A second connection in a process is technically possible and can be useful for isolating long reads or backup work, but it creates another busy handler, auto-checkpoint trigger, statement cache, and lifecycle owner. Whether to permit it is a product/architecture choice.

### Migration locking

1. `runMigrations` sorts and de-duplicates names, starts `BEGIN EXCLUSIVE`, creates/reads the migration ledger, executes all unapplied SQL, inserts matching checksums, and commits; failures roll back (`src/storage/sqlite/migrations.ts:19-90`). This makes the schema and ledger update one transaction and serializes concurrent writers.
2. In WAL mode, `BEGIN EXCLUSIVE` does not produce a reader-excluding maintenance window. SQLite's pager handles WAL write acquisition through the WAL write lock; an exclusive database-file lock is only attempted for `locking_mode=exclusive` ([`src/pager.c:206-222`](https://github.com/sqlite/sqlite/blob/e0725b0a4fce7dca682250f6c5636cb33f15db89/src/pager.c#L206-L222)). SQLite's own superlock helper needs additional WAL locks after `BEGIN EXCLUSIVE` specifically to prevent readers, writers, and checkpointers ([`src/test_superlock.c:202-225`](https://github.com/sqlite/sqlite/blob/e0725b0a4fce7dca682250f6c5636cb33f15db89/src/test_superlock.c#L202-L225)). See [SQLite transaction modes](https://sqlite.org/lang_transaction.html#deferred_immediate_and_exclusive_transactions).
3. The repository's five-process empty-database race test verifies that all workers can run startup migrations and then write without observed corruption (`tests/concurrency.test.ts:97-159`). It does not test a migration while old binaries have active reads/prepared statements, a long-lived reader spans DDL, a migration exceeds the busy budget, or two binaries carry different migration sets.
4. The reference spec's claim that `.exclusive()` is for "operations requiring no concurrent readers" is refuted for this WAL database (`docs/specs/2026-04-03-sqlite-concurrency-at-scale.md:80-88`). `.exclusive()` is still useful here to acquire the writer slot at transaction start, but compatibility/maintenance gating must be designed above SQLite's WAL transaction mode.

### Backup and restore

1. Copying only the main database file while WAL connections are active is unsafe as a backup strategy because committed pages may exist only in `-wal`. Treating the three files as ordinary independently copied files is also unsafe without SQLite's locking/snapshot protocol. See [SQLite WAL](https://sqlite.org/wal.html) and [How To Corrupt An SQLite Database File](https://sqlite.org/howtocorrupt.html#_backup_or_restore_while_a_transaction_is_active).
2. SQLite's online backup API copies one database to another while the source remains live. The destination holds a write transaction for the backup; the source is read-locked only during each step, so other source readers/writers may proceed between steps ([`src/sqlite.h.in:9627-9641`](https://github.com/sqlite/sqlite/blob/e0725b0a4fce7dca682250f6c5636cb33f15db89/src/sqlite.h.in#L9627-L9641)). External source changes restart the next backup step, and same-connection changes update the backup in tandem ([`src/sqlite.h.in:9727-9741`](https://github.com/sqlite/sqlite/blob/e0725b0a4fce7dca682250f6c5636cb33f15db89/src/sqlite.h.in#L9727-L9741)). `SQLITE_BUSY`/`SQLITE_LOCKED` are retryable for a step ([`src/sqlite.h.in:9710-9725`](https://github.com/sqlite/sqlite/blob/e0725b0a4fce7dca682250f6c5636cb33f15db89/src/sqlite.h.in#L9710-L9725)). See the [official Online Backup API](https://sqlite.org/backup.html).
3. SQLite names `VACUUM INTO` as another safe consistent-backup technique ([`src/sqlite.h.in:9812-9820`](https://github.com/sqlite/sqlite/blob/e0725b0a4fce7dca682250f6c5636cb33f15db89/src/sqlite.h.in#L9812-L9820); [VACUUM INTO](https://sqlite.org/lang_vacuum.html#vacuum_with_an_into_clause)). It is a one-shot operation with different blocking, space, and cancellation characteristics from incremental backup; those characteristics need measurement under the intended workload.
4. Bun documents `Database.serialize()` as a wrapper around `sqlite3_serialize` ([Bun SQLite docs, serialize](https://github.com/oven-sh/bun/blob/6089d0e83fa297474232eec15dd8915a245d66af/docs/runtime/sqlite.mdx#L160-L170)). SQLite specifies that serialization of an ordinary on-disk database is a copy of the disk file ([`sqlite3_serialize`](https://sqlite.org/c3ref/serialize.html)); that is not the online-backup protocol. A local Bun 1.3.14 probe serialized a WAL database after a passive checkpoint, but `Database.deserialize()` of those bytes failed with `SQLITE_CANTOPEN`. No backup design should depend on this path without a separate validated conversion and restore test.
5. Current Bun documentation says its newer `node:sqlite` implementation includes `backup()`, while warning that it synchronously blocks Bun's event loop ([Bun Node compatibility docs](https://github.com/oven-sh/bun/blob/6089d0e83fa297474232eec15dd8915a245d66af/docs/runtime/nodejs-compat.mdx#L174-L180)). The installed Bun 1.3.14 cannot resolve `node:sqlite`, and `bun:sqlite.Database` has no `backup` method. Runtime upgrade, `VACUUM INTO`, a separate backup helper, or another primary API are choices, not established implementation facts.

## Current octo-santa contract

### Startup and database discovery

The full current call path is:

```text
main.ts / admin.ts / poll.ts
  -> resolveDbPath()
  -> createDb(path)
       -> create parent directory
       -> open one bun:sqlite Database
       -> busy_timeout=5000
       -> journal_mode=WAL (outer retry)
       -> synchronous=NORMAL
       -> foreign_keys=ON
  -> runMigrations(db, allMigrations)
       -> BEGIN EXCLUSIVE (outer retry)
       -> serve or poll
```

`resolveDbPath()` uses `OCTO_SANTA_DB` when present, otherwise `~/.octo-santa/messages.db`; it expands only a leading `~/` (`src/storage/sqlite/db.ts:6-14`). It does not canonicalize, resolve symlinks, or make other relative values absolute. Consequently, a relative `OCTO_SANTA_DB` is relative to each launcher's current working directory and can silently split one logical deployment across files.

All three entry points use the same resolver (`src/main.ts:10-12`, `src/admin.ts:12-14`, `src/poll.ts:70-75`). There is no user-facing command/tool that reports the resolved path or database identity. Bun's `Database.filename` exists ([Bun SQLite docs](https://bun.sh/docs/runtime/sqlite)), but octo-santa does not expose it.

`poll.ts` describes itself as read-only (`src/poll.ts:1-3`), but startup is not read-only: it opens with `{create: true}`, requests WAL, and runs migrations (`src/poll.ts:70-76`). Only its steady-state query loop is read-only. A topology cannot safely classify this process as a reader until startup/migration ownership is changed.

### Process lifecycle

1. `main` and `admin` retain their database for process lifetime and never explicitly call `db.close()` (`src/main.ts:10-51`, `src/admin.ts:12-26`). `poll` terminates via `process.exit` and likewise does not explicitly close (`src/poll.ts:47-67`). There are no `SIGINT`/`SIGTERM` handlers or explicit database closes under `src/`.
2. Per-connection heartbeat and notification-poller timers are `unref()`'d, so they do not keep the process alive (`src/transports/mcp-stdio/adapter.ts:406-435`, `src/notifications/poller/poller.ts:65-78`). The stdio transport/process owner determines lifetime.
3. MCP transport `onclose` stops the heartbeat and poller, then unregisters the bound agent (`src/transports/mcp-stdio/adapter.ts:442-451`; `src/main.ts:42-44`). This is graceful protocol cleanup, not an OS-signal guarantee. If it is skipped, liveness recovery depends on PID existence and the 15-minute heartbeat threshold (`src/core/utils.ts:8,96-113`) plus compare-and-swap reclaim (`src/storage/sqlite/agent-repo.ts:43-70`).
4. Current Bun source has a normal-exit hook that zeroes the busy timeout, attempts a truncating checkpoint (degrading immediately when blocked), and closes every `bun:sqlite` connection ([`JSSQLStatement.cpp:283-317`](https://github.com/oven-sh/bun/blob/6089d0e83fa297474232eec15dd8915a245d66af/src/jsc/bindings/sqlite/JSSQLStatement.cpp#L283-L317)). Bun's public docs also specify explicit `close()`/`using` behavior and delayed close while prepared statements survive ([Bun SQLite docs, close](https://github.com/oven-sh/bun/blob/6089d0e83fa297474232eec15dd8915a245d66af/docs/runtime/sqlite.mdx#L112-L150)). Application code should still own graceful shutdown rather than depending on GC or an undocumented signal path.

### Narrow local lifecycle probe

A Bun 1.3.14 child process opened a fresh WAL database, disabled auto-checkpointing, used `synchronous=NORMAL`, created a table, inserted and acknowledged one row, and then ended in three ways. File sizes were inspected before any recovery connection opened.

| Termination | Exit | Main DB | WAL | SHM | Row readable after reopening? |
|---|---:|---:|---:|---:|---|
| Normal event-loop exit, no explicit `db.close()` | 0 | 8,192 B | 0 B | 32,768 B | Yes |
| Default `SIGTERM` | 143 | 4,096 B | 12,392 B | 32,768 B | Yes |
| `SIGKILL` | 137 | 4,096 B | 12,392 B | 32,768 B | Yes |

This verifies four local facts only: Bun's normal-exit path checkpointed this tiny workload; macOS persistent-WAL sidecars remained; neither signal path checkpointed; and SQLite recovered the committed WAL transaction while the OS stayed alive. It does **not** verify power-loss durability, sync honesty, large/contended checkpoint behavior, signal-handler execution, or data retention after host/kernel failure.

## Database facts versus product choices

| Area | Verified constraint | Product choice still required |
|---|---|---|
| Writer topology | One WAL writer at a time across all connections/processes. | Queue inside one daemon, let SQLite arbitrate N processes, or run a transition with explicit ownership/routing. |
| Read topology | Readers can coexist with a writer but can hold back checkpoints. | Connection count, read lifetime limits, and whether gateway reads share the writer event loop. |
| Durability | `NORMAL` can lose acknowledged recent commits on host/power failure; `FULL` adds per-commit WAL sync. | Required loss objective and whether commit latency is worth `FULL`; possibly different policy for specific operations. |
| Checkpointing | Current default is per-connection passive checkpoint at 1,000 frames; completion is not guaranteed under readers. | Auto-checkpoint threshold, dedicated checkpoint owner, mode, schedule, WAL-size alarm, and shutdown behavior. |
| Busy policy | Busy timeout is per connection and may be bypassed to avoid deadlock. Current outer retries can block around 21 seconds. | User-visible deadline, fairness, overload response, retry ownership, and whether a central queue replaces outer sleeps. |
| Connections | Separate connections are supported; installed build must not concurrently use one connection from multiple threads. | Preserve one per process, split read/write/backup connections, or isolate DB work in another process. |
| Migrations | Current transaction serializes writers and is atomic, but WAL readers continue. | Single migrator/coordinator, compatibility window, version handshake, startup gate, and rollback/forward-only policy. |
| Backup | SQLite has online backup and `VACUUM INTO`; current `bun:sqlite` has no online-backup wrapper. | Runtime/API, destination/rotation, incremental pacing, encryption/permissions, restore verification, and retention. |
| DB discovery | One resolver exists, but relative overrides can diverge and there is no identity endpoint. | Canonical absolute path, configuration precedence, path/identity reporting, and legacy-file discovery/migration. |
| Process lifecycle | Current cleanup is transport-close based; no signal handlers; process crashes leave recoverable WAL and possibly stale agent ownership. | Supervisor, singleton/socket ownership, signal grace period, draining, restart/reconnect, stale artifact cleanup, and health protocol. |

## Topology implications, not a topology decision

### Central single-writer gateway

A gateway can make queueing, migration, checkpoint, backup, and resolved DB identity have one owner. It does not increase SQLite's physical write concurrency. With the current synchronous driver and synchronous busy sleeps, doing DB work on the gateway's protocol event loop risks head-of-line blocking. The gateway also becomes an availability boundary requiring supervision, connection authentication/authorization, restart/reconnect semantics, and graceful drain behavior that the current stdio-child lifecycle does not provide.

### Federated N-writer processes

This matches current behavior and SQLite's supported local-process locking model. It avoids a daemon dependency, but every process owns a busy handler, auto-checkpoint trigger, startup migration attempt, and runtime version. Tail latency, fairness, checkpoint placement, and schema rollout become emergent multi-process behavior. The existing five-writer test establishes basic progress and no message loss for one small workload (`tests/concurrency.test.ts:23-95`); it is not a capacity or durability result.

### Dual-plane transition

SQLite can safely accept both planes as connections to one WAL database, but "SQLite serialized the writes" is insufficient as a transition protocol. The product must define which plane owns each mutation, how duplicate requests are made idempotent, whether ordering spans planes, which process migrates/checkpoints/backs up, how clients discover the active plane, and what happens if one plane runs an incompatible binary. Without those rules, a dual plane can be database-safe while still violating product semantics.

## Measurements required from later topology prototypes

These cannot be concluded from SQLite documentation or the existing tests:

1. **Real workload queueing:** write throughput and p50/p95/p99/end-to-end latency for realistic transaction mixes under 1, 2, 5, 10, and expected-maximum processes/clients; compare SQLite arbitration with a daemon queue.
2. **Busy behavior:** count and classify `SQLITE_BUSY`, `SQLITE_BUSY_SNAPSHOT`, and `SQLITE_LOCKED`; measure time spent inside the 5-second handler versus outer retry, fairness between processes, starvation, and the user-visible failure deadline.
3. **Gateway event-loop impact:** heartbeat, notification, admin request, and MCP response delay while a synchronous DB call waits, checkpoints, migrates, or backs up. A timer-based unit test cannot infer this under process contention.
4. **Checkpoint behavior:** WAL bytes/frames over time, checkpoint duration, which connection pays auto-checkpoint work, incomplete passive checkpoints, long-reader effects, and close/restart latency on every supported OS/filesystem.
5. **Durability matrix:** acknowledged versus recovered transaction IDs after clean close, protocol EOF, `SIGINT`, `SIGTERM`, `SIGKILL`, daemon crash, kernel/VM crash, and actual power interruption or a controlled storage-fault harness. Process-kill results must not be reported as power-loss proof.
6. **`NORMAL` versus `FULL`:** commit latency distribution and recovered acknowledged transaction boundary on the target filesystem/storage. Verify the chosen VFS/device actually honors sync semantics.
7. **Migration rollout:** concurrent cold start, migration with long readers and active old writers, mixed old/new binaries, failed/slow DDL, busy-budget exhaustion, and post-crash ledger/schema agreement. The test gate must inspect both schema and application compatibility.
8. **Backup under load:** chosen API's source write impact, event-loop blocking, duration, destination size, cancellation/retry, concurrent checkpoint interaction, and automatic restore plus `integrity_check`/application-level invariants. Test backups created while the WAL has uncheckpointed committed frames.
9. **DB identity/discovery:** launches from different working directories, absolute/relative/`~/` overrides, symlinks, simultaneous old and new launchers, missing/unwritable directories, and detection of accidental split-brain database files.
10. **Gateway lifecycle:** singleton acquisition race, stale PID/socket, supervisor restart loop, client reconnect/backoff, in-flight request outcome, graceful drain deadline, admin and messaging coexistence, and behavior when the gateway is unavailable.
11. **Resource footprint:** file descriptors, memory per connection/statement cache, CPU from per-process 2-second polling and 10-second heartbeat, and the crossover where a gateway is cheaper than N federated processes.
12. **Dual-plane correctness:** duplicate submission, retry after ambiguous timeout, cross-plane ordering, ownership handoff, old-plane drain, migration/checkpoint/backup leader failover, and rollback of the transition itself.

## Unresolved gaps

1. The product has no stated recovery point objective. Without an explicit answer for whether recent messages may disappear after machine power loss, `NORMAL` versus `FULL` cannot be decided.
2. Supported Bun versions and operating systems are not pinned. The local Bun 1.3.14 surface differs materially from current Bun source/docs (`node:sqlite` backup availability), and macOS WAL sidecar lifecycle differs from Bun's Linux/Windows builds.
3. No authoritative requirement defines whether a gateway is a machine-wide singleton, per-user singleton, per-database process, or merely one optional client plane.
4. No backup retention, destination trust/permissions, restore-time objective, or restore-validation contract exists.
5. No rolling-schema compatibility contract exists. Current migrations are forward-applied at every entry-point startup, but continuing WAL readers and old binaries are not gated.
6. No canonical database identity is exposed. A resolved absolute path plus a stable file identity is needed before a gateway or migration can reliably prove every participant targets the same database.
7. Bun 1.3.14's exact source revision was not recorded by the installed executable. Runtime probes verify observed behavior, while pinned Bun `6089d0e` source is used only where marked; release-source provenance should be pinned as part of any production topology baseline.

## Primary references

- SQLite: [Write-Ahead Logging](https://sqlite.org/wal.html)
- SQLite: [PRAGMA synchronous](https://sqlite.org/pragma.html#pragma_synchronous)
- SQLite: [PRAGMA wal_checkpoint](https://sqlite.org/pragma.html#pragma_wal_checkpoint)
- SQLite: [Checkpoint API and modes](https://sqlite.org/c3ref/wal_checkpoint_v2.html)
- SQLite: [Busy handler](https://sqlite.org/c3ref/busy_handler.html) and [busy timeout](https://sqlite.org/c3ref/busy_timeout.html)
- SQLite: [Transactions and `DEFERRED`/`IMMEDIATE`/`EXCLUSIVE`](https://sqlite.org/lang_transaction.html#deferred_immediate_and_exclusive_transactions)
- SQLite: [Threading mode](https://sqlite.org/threadsafe.html)
- SQLite: [Online Backup API](https://sqlite.org/backup.html) and [`VACUUM INTO`](https://sqlite.org/lang_vacuum.html#vacuum_with_an_into_clause)
- SQLite source snapshot: [`e0725b0`](https://github.com/sqlite/sqlite/tree/e0725b0a4fce7dca682250f6c5636cb33f15db89)
- Bun: [`bun:sqlite` documentation](https://bun.sh/docs/runtime/sqlite)
- Bun source/docs snapshot: [`6089d0e`](https://github.com/oven-sh/bun/tree/6089d0e83fa297474232eec15dd8915a245d66af)
- Local implementation: `src/storage/sqlite/db.ts:6-67`, `src/storage/sqlite/migrations.ts:19-90`, `src/main.ts:10-45`, `src/admin.ts:12-20`, `src/poll.ts:70-86`
- Local concurrency evidence: `tests/db.test.ts:12-28`, `tests/concurrency.test.ts:23-95,97-159,162-206`, `tests/migrations.test.ts:12-183`
- Local lifecycle evidence: `src/transports/mcp-stdio/adapter.ts:406-451`, `src/notifications/poller/poller.ts:65-78`, `src/core/utils.ts:8,96-113`, `src/storage/sqlite/agent-repo.ts:43-85`
