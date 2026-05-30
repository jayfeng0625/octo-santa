# Entire Integration Adapters

**Date:** 2026-05-13
**Status:** Draft
**Branch:** TBD
**Depends on:** Hexagonal Architecture (`docs/specs/2026-04-04-hexagonal-architecture-design.md`), Brain Module (`docs/specs/2026-04-03-brain-module-design.md`)

## Problem

Octo-santa owns runtime coordination primitives (messaging, brain, safety rails, guidance) but has nothing for the archival half of the agent SDLC:

- No session transcript capture — what each agent actually said and did is lost when the host process exits.
- No commit ↔ decision provenance — code lands in main without a durable back-reference to the conversation or brain doc that produced it.
- No cross-session semantic search — `brain_find_expert` is keyword-scoped to brain docs, not to past agent interactions.
- No redaction pipeline — messages and brain docs can carry secrets; we have no scrub layer.
- No cross-repo agent activity surface — operators have no dashboard for "what did the fleet do this week".

Building these in-tree is a multi-quarter undertaking: per-agent hook integrations (Claude Code, Cursor, Codex, …), JSONL parsers, embeddings, an index, redaction with low false-positive rate, a web UI.

[entire.io](https://entire.io) ships all of the above today, with a model that is *complementary* rather than competing: it captures sessions post-hoc into git refs on a shadow branch `entire/checkpoints/v1` and links them to commits via `Entire-Checkpoint:` trailers. It does not own runtime state, messaging, or coordination — exactly the surfaces octo-santa already owns.

The strategic question is not "pivot to entire" but "where can adapters back octo-santa's archival ports with entire so we never build that infrastructure ourselves".

## Solution

Add four new ports under `src/core/ports.ts` that capture the archival half of the SDLC. Implement entire-backed adapters under `src/integrations/entire/`. Use composition-root detection to wire either the entire adapter (when present) or a local fallback (no-op or minimal local store).

**Strategic principle:** Octo-santa is the source of truth for **live state**. Entire is the source of truth for **durable history**. The adapter boundary is the line between them.

The ports stay sovereign — octo-santa owns its trailer namespace (`Octo-*`), its message schemas, its brain doc format. Entire is an indexer for that data, not its schema owner.

## Design

### New ports

```ts
// src/core/ports.ts (additive)

export interface TranscriptCapturePort {
  // Notify the archival layer that a logical session boundary occurred
  // (agent registered, channel created, brain doc written). Adapters
  // decide whether to materialize this as a checkpoint.
  recordEvent(event: SessionEvent): Promise<void>
}

export interface ProvenancePort {
  // Compose commit-message trailers for the current logical session.
  // Returns lines to append to the next commit message (or empty array
  // when no provenance is active).
  trailersForCommit(ctx: ProvenanceContext): Promise<string[]>

  // Resolve a trailer back to its source (brain doc id, channel id, etc).
  resolve(trailer: string): Promise<ProvenanceTarget | null>
}

export interface RedactionPort {
  // Scrub secrets + opt-in PII from a string. Used at messaging persist
  // boundary and at brain doc write boundary.
  scrub(input: string, opts?: RedactionOpts): string
}

export interface SessionSearchPort {
  // Semantic + keyword search across past agent sessions.
  search(query: string, filters?: SessionFilters): Promise<SessionHit[]>
}
```

### Adapters

Layout under `src/integrations/entire/`:

```
src/integrations/entire/
  ├── detector.ts            — presence check: `entire` on PATH AND .entire/settings.json in repo root
  ├── transcript-adapter.ts  — TranscriptCapturePort impl; writes via `entire` CLI hooks
  ├── provenance-adapter.ts  — ProvenancePort impl; emits Octo-* trailers, reads via `entire checkpoint explain --json`
  ├── search-adapter.ts      — SessionSearchPort impl; shells `entire checkpoint search --json`
  └── README.md              — adapter contract + detection rules
```

Redaction does **not** go through entire's CLI — it uses [Betterleaks](https://github.com/betterleaks/betterleaks) directly as a library dependency. Avoids CLI shell-out hot path; entire-installation independence.

```
src/integrations/betterleaks/
  └── redaction-adapter.ts   — RedactionPort impl
```

### Composition root wiring (`src/main.ts`)

```ts
const entirePresent = await detectEntire(repoRoot)

const transcriptCapture: TranscriptCapturePort = entirePresent
  ? new EntireTranscriptAdapter(opts)
  : new NoOpTranscriptAdapter()

const provenance: ProvenancePort = entirePresent
  ? new EntireProvenanceAdapter(opts)
  : new LocalTrailerAdapter()   // still emits Octo-* trailers, no remote index

const sessionSearch: SessionSearchPort = entirePresent
  ? new EntireSearchAdapter(opts)
  : new NoOpSearchAdapter()     // returns empty; brain_find_expert continues to serve doc-scoped search

const redaction: RedactionPort = new BetterleaksRedactionAdapter()  // always on
```

Detection runs once at process start. No runtime adapter switching. Same pattern as `fs-brain-store` selection.

### Trailer namespace

Octo-santa owns the `Octo-*` namespace. Entire's adapter only relays — it does not invent trailers:

| Trailer | Meaning |
|---|---|
| `Octo-Channel: <id>` | Commit produced during messaging activity on channel `<id>` |
| `Octo-Brain: <doc-id>` | Commit modified or was informed by brain doc `<doc-id>` |
| `Octo-Agent: <name>` | Primary agent identity for this commit |
| `Octo-Session: <uuid>` | Octo-santa session correlation id (independent of entire's checkpoint id) |

When entire is present, its `Entire-Checkpoint:` trailer also lands on the commit via its own hooks — orthogonal, both indexable.

### Redaction integration points

| Boundary | Behavior |
|---|---|
| `messaging_send_message` write path | Scrub body before SQLite insert. Persist scrubbed text; metadata records `redacted: true` if any change. |
| `brain_*` write path (when added) | Scrub before filesystem write. |
| Outbound transcript event | Scrub before passing to TranscriptCapturePort. |

Custom patterns sourced from `.octo-santa/redaction.json` (committed, team-shared) and `.octo-santa/redaction.local.json` (gitignored, per-user). Same dual-file convention entire uses.

### Detection rules

`detectEntire(repoRoot)` returns true iff **all** of:

1. `entire` binary resolvable on `PATH`.
2. `.entire/settings.json` exists at `repoRoot`.
3. `entire status` exits 0 within 2s budget.

Failure of any condition silently falls back. Detection result cached for process lifetime. Never re-checked at runtime.

### Cross-process consideration

Per CLAUDE.md: SQLite is the only cross-process bridge. Adapters MUST NOT introduce a second bridge. Implications:

- Detection result is **per-process** — each MCP subprocess detects on its own at startup.
- Entire CLI shell-out is per-process too — fork+exec from each subprocess as needed.
- No shared in-memory adapter state across subprocesses. Idempotent operations only.

If an adapter ever needs cross-process state (e.g. dedupe of trailer emission), it goes through SQLite, not through a second bridge.

## Implementation Phases

### Phase 1 — Ports + detector + no-op fallbacks (foundation)

- Add four ports to `src/core/ports.ts` with TypeScript types only.
- Implement `detectEntire` + caching.
- Implement no-op adapters for all four ports.
- Wire in composition root behind detection.
- **No behavior change** for users without entire installed.

Exit criteria: tsc passes, no test regressions, `entire status` runs as part of MCP startup when present.

### Phase 2 — Redaction (always-on, entire-independent)

- Add Betterleaks dependency.
- Implement `BetterleaksRedactionAdapter`.
- Hook into messaging send path.
- `.octo-santa/redaction.json` schema + parser.
- Tests: secret patterns scrubbed, custom patterns honored, false-positive cases for code-like strings.

Exit criteria: messages containing API keys are stored redacted; tests cover OpenAI/AWS/GitHub PAT patterns at minimum.

### Phase 3 — Trailer emission (local first, entire-aware second)

- `LocalTrailerAdapter` writes `Octo-*` trailers to a local staging file (`.octo-santa/pending-trailers`) that a user can pipe into `git commit -F`.
- `EntireProvenanceAdapter` (when entire present) routes trailers through entire's hook mechanism so they land on the actual commit alongside `Entire-Checkpoint:`.
- Reverse lookup: `messaging_get_provenance(commit)` returns the linked channel/brain/session.

Exit criteria: a commit produced during a messaging session has `Octo-Channel:` + `Octo-Agent:` trailers, and `git log --grep=Octo-Channel` finds it.

### Phase 4 — Session search adapter

- `EntireSearchAdapter` shells `entire checkpoint search --json`.
- New MCP tool: `messaging_search_history` (or rename brain_find_expert to subsume).
- No-op fallback returns empty array; existing brain_find_expert keeps working.

Exit criteria: when entire is present, agents can query past agent sessions across repos.

### Phase 5 — Transcript capture (last; lowest urgency)

- Entire already captures Claude Code / Cursor / Codex transcripts via its own hooks — octo-santa does NOT need to duplicate that.
- The `TranscriptCapturePort.recordEvent` call only annotates the transcript with octo-santa events (channel created, agent registered, brain claimed).
- Materialized as commit-trailer breadcrumbs (Phase 3) and as side-channel events to entire's hook output where the hook contract permits.

Exit criteria: entire web UI shows octo-santa events inline with its session view.

## Strategic Alignment

Octo-santa's competitive moat is the **runtime fabric** — agent identity, live messaging, safety rails, shared cognition. Entire's moat is the **archival fabric** — capture, search, provenance, dashboards.

These layers are complementary today. They become competitive only if entire ships a runtime coordination primitive (live messaging, agent registry, IPC). Watch list:

- Entire shipping any live messaging / IPC surface → re-evaluate.
- Entire shipping a `BrainStore`-equivalent (live agent memory with conflict resolution) → re-evaluate brain module's relationship to it.

Until those happen, the adapter approach gives octo-santa optionality:

- **If entire wins archival category:** octo-santa users get best-in-class capture for free.
- **If entire pivots or stalls:** swap adapter, ports stay, zero core change.
- **If a third archival tool emerges:** add a new adapter behind the same ports.

## Non-Goals

- **Octo-santa will not implement its own session transcript capture.** Entire already does this well; duplicating it is wasted build. If a user has no archival tool installed, they get no transcript history — that is acceptable.
- **Octo-santa will not implement its own web dashboard.** Entire.io ships this; the adapter pattern means we can surface our data there. A local-only dashboard is out of scope.
- **Octo-santa will not couple core to entire.** Core depends on ports only. Entire-backed adapters live under `src/integrations/entire/` and must never be imported by `src/core/`.
- **No multi-vendor abstraction.** Ports model octo-santa's needs, not the union of every archival vendor's capability. If a future vendor doesn't fit the port, we add a new port — we do not bloat existing ports.

## Risks

| Risk | Mitigation |
|---|---|
| Entire CLI not stable / breaking changes between versions | Pin minimum entire version in detector; degrade to no-op if unsupported. |
| Forces git coupling on workflows that aren't git-native | Adapters are opt-in. Daemon agents and ephemeral workflows fall back to local stubs. |
| Telemetry concerns (entire.io egress) | Document opt-out path. Adapter does not enable entire telemetry. User keeps full `entire` config control. |
| Vendor lock-in via trailer/branch schema | Trailers are plain text; `Octo-*` namespace is owned by octo-santa. Branch `entire/checkpoints/v1` is git — portable. |
| CLI shell-out latency on hot paths | Only Phase 4 search hits the hot path. Adapter caches `entire status` once. Messaging persist path uses Betterleaks library, not shell. |
| Adapter detection false positives (entire installed but misconfigured) | `entire status` exit-code check in detector. Adapter operations log and fall back per-call if shell fails. |
| Distribution friction (users must install entire) | Optional dependency. No-op fallback means octo-santa works standalone. README documents both paths. |

## Open Questions

1. **Trailer composition timing.** When multiple agents touch the same commit (sequential or via subagents), how do trailers compose? Append-only with deduplication? Latest-wins? Needs concrete semantic.
2. **Brain doc redaction policy.** Should brain docs be scrubbed on read or on write? Write is safer (single-pass) but loses information if the secret was needed for some downstream use. Probably write, but flag for testing.
3. **Adapter contract evolution.** As entire's CLI evolves, the adapter must follow. Where does the contract live — pinned to a specific entire version, or feature-detected at runtime? Lean toward version pin with explicit upgrade path.
4. **Composability with the brain shared store.** Should brain shared docs be mirrored into entire's branch automatically when both are present? Or kept as parallel stores with explicit sync? Current preference: parallel, no auto-sync (avoids surprising users).
5. **MCP tool surface.** Does `messaging_search_history` become a new tool, or do we extend `brain_find_expert`? Cleaner separation suggests a new tool; UX suggests overload. Decide during Phase 4 planning.

## Out of Scope (Future Work)

- Live entire web sign-in flow from octo-santa CLI.
- Dispatch (markdown summary) generation as an octo-santa MCP tool.
- Bi-directional sync of brain docs and entire transcripts.
- Adapters for non-entire archival systems (defer until a credible alternative ships).
