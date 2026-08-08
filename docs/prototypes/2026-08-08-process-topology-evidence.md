# Process Topology Evidence

**Question:** What measured process-level differences constrain a central single-writer Delivery Gateway versus federated N-writer processes?

**Issue:** [Prototype and compare gateway process topologies](https://github.com/jayfeng0625/octo-santa/issues/38)

**Baseline:** octo-santa `e99988029ab01191a02bf0144e0dee58916a9aae`, Bun `1.3.14`, SQLite `3.51.0`, macOS arm64.

**Primary evidence:**

- [`process-topology-evidence.ts`](../../scripts/prototypes/process-topology-evidence.ts) is the disposable process-level probe.
- [`2026-08-08-process-topology-evidence.json`](./2026-08-08-process-topology-evidence.json) contains the complete request samples, connection audit, checkpoint results, crash observations, integrity checks, and interpretation boundary.

## Structurally Different Candidates

The central candidate starts one persistent gateway worker. It is the only steady-state process given the database path, opens one SQLite connection, and receives every write and control request through its process protocol.

The federated candidate starts one persistent worker per fake source client. Every worker receives the database path, opens its own SQLite connection, and handles only its assigned client. Each SQLite-opening process records its PID and role in `connection_audit`.

The candidates therefore differ in enforced process and connection ownership, not a topology label applied to one shared state machine.

## Observations

### Queueing and writer-lock acquisition

Each client committed eight short transactions containing a deliberate 2 ms synchronous hold. All runs completed every write with `integrity_check=ok` and no exhausted busy retry. Measurements are local observations, not capacity claims.

| Sync | Clients | Topology | Wall time | Request p95 | Writer-lock p95 | Observed writer PIDs |
|---|---:|---|---:|---:|---:|---:|
| `NORMAL` | 1 | Central | 23.771 ms | 4.352 ms | 0.019 ms | 1 |
| `NORMAL` | 1 | Federated | 23.535 ms | 4.364 ms | 0.010 ms | 1 |
| `NORMAL` | 5 | Central | 105.994 ms | 13.460 ms | 0.012 ms | 1 |
| `NORMAL` | 5 | Federated | 105.431 ms | 46.888 ms | 44.241 ms | 5 |
| `NORMAL` | 10 | Central | 210.432 ms | 26.412 ms | 0.013 ms | 1 |
| `NORMAL` | 10 | Federated | 210.382 ms | 89.194 ms | 86.469 ms | 10 |
| `FULL` | 1 | Central | 24.675 ms | 4.706 ms | 0.009 ms | 1 |
| `FULL` | 1 | Federated | 24.143 ms | 4.585 ms | 0.008 ms | 1 |
| `FULL` | 5 | Central | 109.431 ms | 13.905 ms | 0.013 ms | 1 |
| `FULL` | 5 | Federated | 108.994 ms | 46.292 ms | 43.066 ms | 5 |
| `FULL` | 10 | Central | 216.118 ms | 27.165 ms | 0.009 ms | 1 |
| `FULL` | 10 | Federated | 215.520 ms | 91.630 ms | 88.260 ms | 10 |

Overall wall time stayed close because SQLite serialized both candidates' writes. The location of waiting differed: the central candidate queued requests before one uncontended writer, while federated request latency included SQLite writer-lock acquisition.

This run does not establish a meaningful `NORMAL` versus `FULL` performance choice. The observed differences were small on this machine and workload, and the probe cannot simulate storage power loss or prove sync honesty.

### Checkpoint ownership

At 5 and 10 clients, the central candidate issued one passive checkpoint and completed every observed WAL frame. The federated candidate issued simultaneous checkpoint requests from every writer; exactly one completed the frames while every other process returned immediate `busy=1`, `log=-1`, `checkpointed=-1`.

SQLite safely arbitrated the work, but did not choose a durable lifecycle owner. Central ownership is structural; a federated checkpoint leader or equivalent policy remains application work.

### Synchronous event-loop isolation

The worker confirmed acquisition of a 250 ms synchronous transaction, then the probe waited 25 ms before sending control pings:

| Probe | Ping latency |
|---|---:|
| Central gateway process | 229.878 ms |
| Federated process running the transaction | 229.135 ms |
| Unrelated federated process | 0.392 ms |

Synchronous SQLite work blocked the owning Bun event loop in both candidates. The central candidate made that event loop the complete gateway control boundary; the federated candidate left another process responsive.

### Crash blast radius and ambiguous retry

Both writer processes were killed with `SIGKILL` immediately after commit and before a response. Both databases reopened with `integrity_check=ok`, and retrying the same source ID returned the existing row. This establishes application-process recovery while the OS remained alive, not host or power-loss durability.

The sole observed central writer exited before a replacement process became ready 17.270 ms later in this unsupervised local probe. This structurally left no writer process; the probe did not fabricate a request endpoint while no gateway existed. After one federated writer was killed, the surviving process answered a ping in 0.292 ms and committed an unrelated row before the crashed writer was replaced.

### Database identity

One relative database configuration resolved by the central gateway created `launcher-a/central-relative.sqlite`; clients never received or independently resolved the path. Two federated launchers given the same relative string from different working directories created `launcher-a/federated-relative.sqlite` and `launcher-b/federated-relative.sqlite`.

This measures the existing configuration risk, not an inherent requirement that federated launchers use relative paths. Canonical absolute identity can be added to either topology, but every federated launcher must participate in that policy.

## Judgment Boundary

The observations constrain the architecture but do not select it.

- Centralization concentrates writer, checkpoint, and database-identity ownership and replaces SQLite lock competition with one application queue. It also concentrates synchronous event-loop delay and writer-process failure into one availability boundary requiring supervision, reconnect, ambiguous-result handling, and drain semantics.
- Federation isolates process and event-loop failures. It distributes lock waiting, checkpoint attempts, startup/migration policy, and database identity across every launcher.
- The `Envelope`, `Delivery`, `Submission`, and `Observation` contract does not discriminate these process topologies. The corrected probe does not re-prove those semantics, and does not use assumed parity as an automatic topology-selection rule.

## North-Star Disposition

The following survive as topology-neutral requirements, but were not remeasured by this corrected discriminator probe:

- SQLite persistence is authoritative before acknowledgement.
- Submission is not Observation; model visibility requires separate evidence.
- Cross-process Delivery cannot depend on shared memory.
- Ordering is scoped to one Route Binding so unrelated bindings can progress.
- Ambiguous source retries require stable idempotency identity.
- Wrapper-attested sender authority remains governed by ADR-0001.

No topology-coupled behavior is superseded because this prototype selects no topology. Whether every launcher participates in SQLite lifecycle policy, or one Delivery Gateway process owns the complete write and lifecycle plane, remains part of the human architecture choice.

**Decision:** `topologySelected = null`. Return the choice to human architecture judgment after recovery objectives, supervision expectations, rollout policy, backup/restore requirements, and supported-platform limits are settled.

## Inconclusive or Unmeasured

- Host, kernel, VM, storage-device, and power-loss durability.
- Mixed old/new schema binaries, long readers spanning DDL, slow or failed migrations, and startup version gates.
- Restore-tested online backup under uncheckpointed WAL and its event-loop/source-write impact.
- Target-hardware capacity, realistic transaction mixes, resource crossover, and production tail-latency budgets.
- Queue fairness and starvation bounds; client-completion spread is only a descriptive local measurement.
- WAL growth over time and truncation/reclamation; the probe records one pre-checkpoint size and passive-checkpoint frame result per run.
- Singleton acquisition, stale sockets, supervisor restart loops, reconnect/backoff, bounded drain, and in-flight request outcome protocols.
- A governed dual-plane ownership handoff. This corrected prototype does not invent one to make a transition pass.
- Fresh offline wake-up, per-Route-Binding ordering, Submission/Observation, and MCP compatibility probes. These topology-neutral requirements are not selection evidence.

## Reproduce

```bash
bun scripts/prototypes/process-topology-evidence.ts --output docs/prototypes/2026-08-08-process-topology-evidence.json
```
