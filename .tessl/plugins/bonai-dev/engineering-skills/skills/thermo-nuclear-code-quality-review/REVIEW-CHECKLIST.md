# Thermo-Nuclear Review — Reference Checklist

The exhaustive lists behind `SKILL.md`. Pull from these while reviewing; the SKILL body carries the workflow and the core bar.

## Flag aggressively

- A complicated implementation where a cleaner reframing could delete whole categories of complexity.
- Refactors that move code around but don't reduce the number of concepts a reader must hold in their head.
- A file crossing 1000 lines because of the PR, especially when the new code could be split out.
- New conditionals bolted onto unrelated code paths; one-off booleans, nullable modes, or flags that complicate existing control flow.
- Feature-specific logic leaking into general-purpose modules; logic added in the wrong layer/package when a clear canonical home exists.
- Generic "magic" handling that hides simple structure; thin wrappers or identity abstractions that add indirection without simplifying.
- Unnecessary casts, `any`, `unknown`, or optional params that muddy the real contract.
- Copy-pasted logic instead of an extracted helper; a bespoke helper where a canonical utility already exists.
- Narrow edge-case handling stuffed into the middle of an already busy function.
- Refactors that pass tests but leave the code less modular or readable; "temporary" branching likely to become permanent debt.
- Sequential async flow where independent work could run in parallel more simply; partial-update logic that leaves state less atomic than necessary.

## Primary review questions

For every meaningful change:

- Is there a "code judo" move that makes this dramatically simpler?
- Can it be reframed so fewer concepts, branches, or helper layers are needed?
- Does this improve or worsen the local architecture? Did a cohesive module become more coupled, stateful, or harder to scan?
- Did the diff add branching where a better abstraction should exist? Repeated conditionals that signal a missing model/helper?
- Is the logic in the right file and layer, or did detail leak across a boundary?
- Did this enlarge a file/component past a healthy size boundary?
- Is the abstraction earning its keep, or is it just a wrapper? Did the diff add casts/optionality/ad-hoc shapes that obscure the invariant?
- Is the orchestration more sequential or less atomic than it needs to be?

## Preferred remedies

- Delete a layer of indirection rather than polishing it.
- Reframe the state model so conditionals disappear instead of getting centralized.
- Change the ownership boundary so the feature becomes a natural extension of an existing abstraction.
- Turn special-case logic into a simpler default flow with fewer exceptions.
- Extract a helper or pure function; split a large file into focused modules.
- Replace condition chains with a typed model or explicit dispatcher; separate orchestration from business logic.
- Collapse duplicate branches into one clearer flow; delete wrappers that don't clarify the API.
- Reuse the canonical helper instead of a near-duplicate; move logic to the module/layer that owns the concept.
- Make type boundaries explicit so control flow simplifies; parallelize independent work when it also simplifies orchestration; restructure related updates to be more atomic.

## Approval bar

Do not approve merely because behavior seems correct. Treat these as presumptive blockers unless clearly justified:

- Preserves a lot of incidental complexity when a plausible code-judo move would delete it.
- Pushes a file from below 1000 to above 1000 lines.
- Adds ad-hoc branching that tangles an existing flow.
- Solves a local problem by scattering feature checks across shared code.
- Adds an unnecessary abstraction, wrapper, or cast-heavy contract that makes the design more indirect.
- Duplicates an existing helper or puts logic in the wrong layer when a clear canonical home exists.

## Tone & useful phrases

Be direct, serious, demanding — not rude. Don't soften major maintainability issues into mild suggestions.

- `this pushes the file past 1k lines. can we decompose this first?`
- `this adds another special-case branch into an already busy flow. can we move this behind its own abstraction?`
- `this works, but it makes the surrounding code more spaghetti. let's keep the behavior and restructure.`
- `this feels like feature logic leaking into a shared path. can we isolate it?`
- `this abstraction seems unnecessary. can we just keep the direct flow?`
- `why does this need a cast / optional here? can we make the boundary more explicit instead?`
- `this looks like a bespoke helper for something we already have. can we reuse the canonical one?`
- `i think there's a code-judo move here that makes this much simpler. can we reframe so these branches disappear?`
- `this refactor moves complexity around but doesn't delete it. is there a way to make the model itself simpler?`
