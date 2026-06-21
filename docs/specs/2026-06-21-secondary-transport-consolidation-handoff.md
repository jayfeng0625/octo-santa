---
title: Secondary Transport + Tool Consolidation — Handoff
summary: Agreed direction from the grill-with-docs session. Pick up here next session.
status: direction-agreed (pre-prototype, pre-spec)
branch: claude/secondary-transport-consolidation-7g81n5
date: 2026-06-21
tags: [transport, cloudflare, durable-objects, tool-consolidation, handoff]
---

# Handoff — Secondary Transport + Tool Consolidation

## Why this exists

`claude-channel` (the `notifications/claude/channel` push over MCP stdio) is the
only push path today, and it works **only on Claude Code**. A new team/enterprise
consumer runs MCP hosts where that capability isn't enabled, so those agents get
zero push. We're adding a **second transport alongside** `claude-channel` and, at
the same time, **consolidating the tool surface**.

## What we agreed (the direction)

Authoritative records are committed — read these first, this note just orients:

- **ADR 0002** — Transports are isolated message buses (`docs/adr/0002-...md`)
- **ADR 0003** — Cloudflare MCP server + single bus Durable Object (`docs/adr/0003-...md`)
- **ADR 0004** — Clean-break thin tool surface, 5 verbs (`docs/adr/0004-...md`)
- **CONTEXT.md** — new glossary terms: Transport, Message Bus, Claude Channel,
  Cloudflare Transport, Bus Durable Object, Context Injection, Messaging Tool
  Surface, Correlation Id.

### Transport
- New transport = **Cloudflare MCP server over Streamable HTTP**, backed by a
  **single bus Durable Object** (owns DO-SQLite, holds all agents' live streams,
  in-memory synchronous fan-out → **no cross-process poller** on this transport).
- Runs locally on **Miniflare / `wrangler dev`** (≈ production), deployable to
  Cloudflare for **private-network** reach (the thing stdio can't do).
- We **delegate infra** (durability, hibernation, networking, auth, deploy) to
  Cloudflare and build only messaging capabilities on top. We are **not** rolling
  our own Node HTTP server (rejected — reinvents infra).
- **Channel-sharded DOs** are a deferred scale-out, NOT now. Reason: messaging is
  a bipartite agent×channel relation; sharding either axis forces cross-DO RPC.
- **Transports are isolated buses** (ADR 0002): agents must start on the same
  transport to talk. Cross-transport messaging is a non-goal.

### Context injection (the subtle part)
- True push moves bytes to the client; it does **not** guarantee the message
  enters the LLM's context. Only Claude Code injects `claude/channel` notifications.
- On every other host the **ubiquitous** injection path is a **blocking `receive`
  tool result** (tool results always land in context). The codebase already relies
  on this for Codex/OpenCode/Gemini (see the NON-PUSH block in
  `src/transports/mcp-stdio/adapter.ts`).
- Over Streamable HTTP the worker **holds the `receive` request open** and answers
  instantly on arrival (real long-poll, not interval polling). Must respect client
  tool-call **timeouts** (bound the wait, ~30s, then loop). `claude/channel`
  notification push does NOT exist over HTTP.

### Selection / run model
- `--transport <claude-channel|...>` is a flag on the **stdio binary** only.
- The Cloudflare transport is **run separately** (Miniflare/wrangler) and connected
  by **`url`** in `mcp.json` — a client can't launch an HTTP server over stdio.

### Tools (clean break)
- **12 `messaging_*` tools → 5 verbs**, clean break **across both transports**,
  **no compat aliases** (legacy behavior = pin the prior compiled release).
- Verbs: `register` · `send` (folds create_channel + subscribe + DM + `reply_to`)
  · `receive` (folds listen + read_messages, blocking) · `discover` (folds the 3
  list tools) · `instructions`. `rename_channel` dropped.
- **Correlation ids first-class**: `reply_to` on send, `correlation_id` on received
  messages → structured request/reply (maps to the `consult` action).
- One tool layer defined against `MessagingService`, shared by both adapters.

### Runtime
- **De-Bun the code**: drop `bun:sqlite` / `Bun.*` refs so core is portable to
  Node + workerd. Build with Bun, run on Node (stdio side) / workerd (worker side).
- Two storage adapters result: `node:sqlite` (local file, `claude-channel`) and
  **DO-SQLite** (Cloudflare transport). Per ADR 0002 they don't share state.

## Open / not yet decided
- Exact `node:sqlite` vs keeping `bun:sqlite` at runtime for the stdio side.
- Auth model for the deployed (non-local) Cloudflare transport.
- Whether `instructions` stays long-term or collapses once the surface settles.
- Stream **resumability** (DurableObjectEventStore) — nice-to-have, not scoped yet.
- Wrapper vs raw-host consumer story (deferred in Q1; thin surface serves both).

## Next steps (do these next session)
1. **`prototype`** the riskiest unknown first: a throwaway worker with the **single
   bus DO**, two fake agents, one `send` → held-open `receive` round-trip, run on
   `wrangler dev`/Miniflare. Prove held-open delivery + in-memory fan-out work.
   Capture the verdict, then delete.
2. **`to-prd`** → **`to-issues`**: formalize the spec and ticket the build
   (note: `to-prd` writes to a Notion PRDs DB and needs `setup-bonai-skills`
   config; fall back to a committed `docs/specs/` markdown spec if unwired).
3. **`tdd` / `implement`**: de-Bun core; shared 5-verb tool layer; Cloudflare
   worker + bus DO adapter; DO-SQLite storage adapter; update
   `docs/architecture.md` push section (currently asserts claude/channel + poller
   as the only paths).

## State
- Branch: `claude/secondary-transport-consolidation-7g81n5` (pushed).
- Skills installed via `npx tessl i bonai-dev/engineering-skills` (.tessl/, .mcp.json,
  tessl.json untracked — decide whether to commit those).
- No production code changed yet — only ADRs, glossary, and this handoff.
