---
name: zoom-out
description: Pulls back from line-level focus to map an unfamiliar code area — lists a module's exports/public interface, traces its callers and importers, summarizes each module's responsibility, and shows how the area fits the larger architecture, using the project's domain-glossary vocabulary. Use when asked to "zoom out", "explain this code", "give me the bigger picture", "what does this module do", "how does this fit in", or when entering an unfamiliar codebase area and needing orientation before diving deeper.
disable-model-invocation: true
---

# Zoom Out

Go up a layer of abstraction. The user doesn't know this area well and needs a **map**, not a line-by-line read — module boundaries, callers, and how the section fits the whole.

## Process

1. **Fix the target.** Identify the module / directory / file the user is oriented around.
2. **List its public surface.** Find what it exports — the functions, types, and entry points other code depends on. Ignore private internals at this stage.
3. **Trace the callers.** Search the codebase for who imports or invokes that surface (`grep`/`rg` for the module path and exported symbols). These inbound edges are how it fits in.
4. **Summarize each neighbour.** For the target and its direct collaborators, give a one-line responsibility — what it owns, not how it works.
5. **Place it in the architecture.** Say which layer/subsystem it lives in and what it depends on downstream.

Ground every name in the project's **domain glossary** (see the **Domain language** entry in CLAUDE.md / AGENTS.md, written by `/setup-bonai-skills`). If no glossary is set up, use the codebase's own naming rather than inventing terms.

## Output shape

Lead with a 1–2 sentence orientation, then a compact map:

```
<target> — <one-line responsibility>
  exports:  <key public functions / types>
  called by:
    <module A> — <why it calls in>
    <module B> — <why it calls in>
  depends on:
    <module C> — <what it needs downstream>
  fits: <which layer / subsystem, and the role it plays there>
```

Keep it scannable. End by naming the single best next file to read to go one level deeper.
