---
name: thermo-nuclear-code-quality-review
description: Runs an extremely strict maintainability review of a branch's changes — flags oversized files, leaky abstractions, spaghetti-condition growth, cast/optionality churn, and wrong-layer logic, then proposes ambitious "code-judo" restructurings that preserve behavior while deleting complexity. Use for a thermo-nuclear code quality review, thermonuclear review, deep code quality audit, or especially harsh maintainability review.
disable-model-invocation: true
---

# Thermo-Nuclear Code Quality Review

An unusually strict review focused on implementation quality, maintainability, abstraction quality, and codebase health.

Above all, be **ambitious** about structure. Don't stop at local cleanup — hunt for "code judo": restructurings that preserve behavior while making the implementation dramatically simpler, smaller, more direct. Prefer deleting complexity over rearranging it. Aim for the version that makes the change feel inevitable in hindsight.

## Core prompt

> Perform a deep code quality audit of the current branch's changes. Rethink how to structure/implement them to meaningfully improve quality without changing behavior — better abstractions and modularity, less spaghetti, more succinct and legible code. Be ambitious: if there's a clear path that involves restructuring some of the codebase, take it. Be extremely thorough and rigorous. Measure twice, cut once.

## Workflow

1. **Get the diff.** Review the current branch's changes as a whole, not file-by-file.
2. **Scan for structural regressions first** — before any nit. Run the checklist below over the diff.
3. **Look for the code-judo move.** For each meaningful change, ask: can this be reframed so whole branches, helpers, modes, or layers disappear? (Fuller question list and remedy menu in [REVIEW-CHECKLIST.md](./REVIEW-CHECKLIST.md).)
4. **Prioritize findings** (see Output) and draft the review with concrete, actionable restructurings — not "maybe rename this."
5. **Apply the approval bar.** Before submitting, verify none of the presumptive blockers survive unjustified.

## The checklist — what to hold the line on

- **Ambitious simplification.** Is there a reframe that deletes categories of complexity rather than relocating them?
- **File size.** A PR pushing a file from under 1k to over 1k lines is a strong smell — decompose first unless there's a compelling, still-clearly-organized reason.
- **No spaghetti growth.** Be hostile to new ad-hoc conditionals, scattered special cases, and one-off branches dropped into unrelated flows. Push logic into a dedicated abstraction/state machine/policy instead of tangling an existing path.
- **Clean the design, don't just accept working code.** If behavior can stay the same while structure gets meaningfully cleaner, push for it. Prefer removing moving pieces over spreading the same complexity around.
- **Direct over magical.** Flag brittle/ad-hoc/"magic" behavior, thin wrappers, and identity pass-throughs that add indirection without clarity.
- **Type & boundary cleanliness.** Question needless optionality, `any`/`unknown`, and cast-heavy code. Prefer explicit typed models and shared contracts; make a silent-fallback invariant explicit instead.
- **Canonical layer & reuse.** Call out feature logic leaking into shared paths and implementation detail leaking through APIs. Prefer existing canonical helpers over bespoke one-offs; push code to the package/module that owns the concept.
- **Orchestration & atomicity.** Flag needless sequential orchestration of independent work, and updates that can leave state half-applied — when the cleaner structure is obvious.

## Example — a code-judo move, not a rename

```js
// BEFORE — a special-case branch bolted onto an unrelated flow
function priceFor(item, ctx) {
  let p = item.base;
  if (ctx.region === "EU") p = applyVat(p);        // tax concern...
  if (ctx.coupon) p = p - ctx.coupon.amount;       // ...promo concern...
  if (ctx.isWholesale) p = p * 0.8;                // ...channel concern, all tangled
  return p;
}

// AFTER — the model itself carries the concepts; the conditionals disappear
const ADJUSTMENTS = [vatAdjustment, couponAdjustment, wholesaleAdjustment];
const priceFor = (item, ctx) =>
  ADJUSTMENTS.reduce((p, adj) => adj(p, ctx), item.base);
```

The "after" isn't tidier wording of the same branches — it deletes the branching by making each pricing rule a uniform adjustment. That's the bar.

## Output

Prioritize: (1) structural regressions → (2) missed dramatic-simplification / code-judo → (3) spaghetti/branching growth → (4) boundary/abstraction/type-contract problems → (5) file-size/decomposition → (6) modularity → (7) legibility. Prefer a few high-conviction comments over a long list of cosmetic nits.

## Approval bar

Do not approve merely because behavior seems correct. The full presumptive-blocker list and the example review phrases live in [REVIEW-CHECKLIST.md](./REVIEW-CHECKLIST.md). The short version: no unjustified structural regression, file-size explosion, spaghetti growth, magical abstraction, cast/optionality churn, boundary leak, or obvious missed decomposition. Where one stands, leave explicit, actionable feedback and push for the cleaner decomposition.
