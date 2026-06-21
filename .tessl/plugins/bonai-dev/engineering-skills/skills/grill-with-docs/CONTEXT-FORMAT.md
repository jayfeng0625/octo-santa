# Glossary entry template

Each glossary entry in `CONTEXT.md` (under the `## Language` section) is one canonical term. The **bold term label** is the term; the entry body uses this shape:

```md
{One or two sentence description of what the term IS. Define it, do not describe what it does.}

**Aliases to avoid:** {alias1, alias2}  ← omit this line if there are none

**Related terms:** [[Other Term]], [[Another Term]]  ← omit if there are none

**Example dialogue:**

> Dev: "When the customer cancels..."
> Domain expert: "You mean cancels the Order, not the Subscription."
```

## Rules

- **Be opinionated.** When multiple words exist for the same concept, pick the best one and list the others under "Aliases to avoid".
- **One or two sentences max.** Define what the term IS, not what it does.
- **Show relationships.** Use `[[Other Term]]` to link to other glossary pages.
- **Flag ambiguities.** If a term is used ambiguously in code or conversation, capture the resolution explicitly in the body.
- **Only include terms specific to this project's domain.** General programming concepts (timeouts, error types, utility patterns) don't belong even if the project uses them extensively.
- **Add an example dialogue.** A short exchange between a dev and a domain expert that clarifies the term's boundary with related concepts.

## Why this shape

`CONTEXT.md` is a flat list of terms under `## Language` — no branching by domain. If a monorepo needs to separate ordering-domain terms from billing-domain terms, group them under sub-headings within `CONTEXT.md` (not by spawning multiple glossary files).
