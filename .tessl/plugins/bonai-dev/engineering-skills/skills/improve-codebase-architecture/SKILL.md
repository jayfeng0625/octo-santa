---
name: improve-codebase-architecture
description: Surveys a codebase for **deepening opportunities** — shallow modules whose interface is nearly as complex as their implementation — and proposes refactors that move complexity behind smaller interfaces, producing an HTML report with before/after diagrams per candidate. Grounded in the project's domain glossary and ADRs so suggestions use canonical names and don't re-litigate documented decisions. Use when the user says "improve the architecture", "find refactoring opportunities", "clean up the code structure", "reduce technical debt", "find code smells", "simplify dependencies", "make this more testable", "consolidate tightly-coupled modules", "find deepening opportunities", or wants a high-level architectural review of a codebase.
---

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. The aim is testability and AI-navigability.

## Glossary & ADRs

The domain glossary and ADRs are fixed filesystem conventions — read and write them directly:

- **Read the glossary** from `CONTEXT.md` at the repo root — to learn the canonical names for modules, seams, and concepts before proposing renames.
- **Read the ADRs** from `docs/adr/` — to avoid suggesting refactors that an ADR forbids.
- **Write a glossary entry** by appending to `CONTEXT.md` — when a deepened module needs a new canonical name.
- **Create an ADR** as `docs/adr/NNNN-<slug>.md` (`NNNN` = highest existing number plus one) — when the user rejects a candidate for a non-obvious, durable reason.

This is a soft dependency: if `CONTEXT.md` or `docs/adr/` is absent, degrade gracefully — proceed with the architecture review and skip the grounding/writes that have nowhere to read from or land.

## Glossary

Use these terms exactly: **Module**, **Interface**, **Implementation**, **Depth** (Deep / Shallow), **Seam**, **Adapter**, **Leverage**, **Locality**. Don't drift into "component," "service," "API," or "boundary." Full definitions and key principles (deletion test, the-interface-is-the-test-surface, two-adapters-make-a-seam) in [LANGUAGE.md](LANGUAGE.md).

This skill is _informed_ by the project's domain model — the domain language gives names to good seams; ADRs record decisions the skill should not re-litigate.

## Process

### 1. Explore

Before exploring, read the glossary from `CONTEXT.md` and the ADRs from `docs/adr/` to load the canonical vocabulary and respect documented decisions. If either is absent, proceed without it.

Then use the Agent tool with `subagent_type=Explore` to walk the codebase. Don't follow rigid heuristics — explore organically and note where you experience friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where have pure functions been extracted just for testability, but the real bugs hide in how they're called (no **locality**)?
- Where do tightly-coupled modules leak across their seams?
- Which parts of the codebase are untested, or hard to test through their current interface?

Apply the **deletion test** to anything you suspect is shallow: would deleting it concentrate complexity, or just move it? A "yes, concentrates" is the signal you want.

### 2. Present candidates as an HTML report

Write a self-contained HTML file to the OS temp directory so nothing lands in the repo. Concrete pattern (POSIX shells):

```bash
tmp="${TMPDIR:-/tmp}"
ts=$(date +%Y%m%d-%H%M%S)
report="$tmp/architecture-review-$ts.html"
# … write HTML to "$report" …
case "$(uname -s)" in
  Darwin) open "$report" ;;
  Linux)  xdg-open "$report" ;;
  *)      echo "Open manually: $report" ;;
esac
echo "Report written to: $report"
```

The report uses **Tailwind via CDN** for layout and styling, and **Mermaid via CDN** for diagrams where a graph/flow/sequence reliably communicates the structure. Mix Mermaid with hand-crafted CSS/SVG visuals — use Mermaid when relationships are graph-shaped (call graphs, dependencies, sequences), and hand-built divs/SVG when you want something more editorial (mass diagrams, cross-sections, collapse animations). Each candidate gets a **before/after visualisation**. Be visual.

For each candidate, the same template as before, but rendered as a card:

- **Files** — which files/modules are involved
- **Problem** — why the current architecture is causing friction
- **Solution** — plain English description of what would change
- **Benefits** — explained in terms of locality and leverage, and how tests would improve
- **Before / After diagram** — side-by-side, custom-drawn, illustrating the shallowness and the deepening
- **Recommendation strength** — one of `Strong`, `Worth exploring`, `Speculative`, rendered as a badge

End the report with a **Top recommendation** section: which candidate you'd tackle first and why.

**Use the project's domain glossary vocabulary for the domain, and [LANGUAGE.md](LANGUAGE.md) vocabulary for the architecture.** If the glossary defines "Order," talk about "the Order intake module" — not "the FooBarHandler," and not "the Order service."

**ADR conflicts**: if a candidate contradicts an existing ADR, only surface it when the friction is real enough to warrant revisiting the ADR. Mark it clearly in the card (e.g. a warning callout: _"contradicts ADR-0007 — but worth reopening because…"_). Don't list every theoretical refactor an ADR forbids.

Minimal candidate-card sketch (one per opportunity, dropped into the report body):

```html
<article class="rounded-lg border p-4 mb-4">
  <header class="flex justify-between">
    <h2 class="font-bold">OrderIntake — collapse 4 shallow handlers</h2>
    <span class="rounded bg-green-200 px-2 text-sm">Strong</span>
  </header>
  <p><strong>Problem:</strong> the 4 handlers share state and ordering rules; callers must know all 4.</p>
  <p><strong>Solution:</strong> single OrderIntake adapter behind one method; handlers become private impl.</p>
  <div class="grid grid-cols-2 gap-2 mt-2">
    <pre class="mermaid">graph LR; A-->H1; A-->H2; A-->H3; A-->H4</pre>
    <pre class="mermaid">graph LR; A-->OrderIntake</pre>
  </div>
</article>
```

See [HTML-REPORT.md](HTML-REPORT.md) for the full HTML scaffold, diagram patterns, and styling guidance.

Do NOT propose interfaces yet. After the file is written, ask the user: "Which of these would you like to explore?"

### 3. Grilling loop

Once the user picks a candidate, drop into a grilling conversation. Walk the design tree with them — constraints, dependencies, the shape of the deepened module, what sits behind the seam, what tests survive.

Side effects happen inline as decisions crystallize:

- **Naming a deepened module after a concept not in the glossary?** Append a glossary entry for the new term to `CONTEXT.md` — same discipline as `/grill-with-docs` (see [CONTEXT-FORMAT.md](../grill-with-docs/CONTEXT-FORMAT.md) for the entry shape).
- **Sharpening a fuzzy term during the conversation?** Update `CONTEXT.md` right there — edit the existing entry in place if the term is already defined, otherwise append a new one.
- **User rejects the candidate with a load-bearing reason?** Offer an ADR — write it as `docs/adr/NNNN-<slug>.md` (`NNNN` = highest existing number plus one), framed as: _"Want me to record this as an ADR so future architecture reviews don't re-suggest it?"_ Only offer when the reason would actually be needed by a future explorer to avoid re-suggesting the same thing — skip ephemeral reasons ("not worth it right now") and self-evident ones. See [ADR-FORMAT.md](../grill-with-docs/ADR-FORMAT.md) for the file shape.
- **Want to explore alternative interfaces for the deepened module?** See [INTERFACE-DESIGN.md](INTERFACE-DESIGN.md).
