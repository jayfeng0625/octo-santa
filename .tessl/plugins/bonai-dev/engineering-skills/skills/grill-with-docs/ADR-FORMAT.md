# ADR file template

A single ADR file (`docs/adr/NNNN-<slug>.md`) = one decision. The **`# ` heading** is the short decision name. The **body** uses this shape:

```md
{1-3 sentences: what's the context, what did we decide, and why.}
```

That's it. An ADR can be a single paragraph. The value is in recording *that* a decision was made and *why* — not in filling out sections.

## Optional body sections

Only add these when they genuinely help. Most ADRs won't need them.

- **Considered Options** — when the rejected alternatives are worth remembering
- **Consequences** — when non-obvious downstream effects need to be called out

## Optional frontmatter

The ADR file may carry YAML frontmatter at the top. All fields are optional — add them only when they earn their place:

```md
---
status: accepted   # proposed | accepted | deprecated | superseded
area: billing      # for multi-area repos, the part of the system this ADR governs
superseded_by: 0012-<slug>  # the ADR file that replaces this one
---
```

- **status** (`proposed | accepted | deprecated | superseded`) — useful when decisions are revisited
- **area** — for multi-area repos, tag the part of the system this ADR governs
- **superseded_by** — name the ADR file that replaces this one

## When to offer an ADR

All three must be true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will look at the code and wonder "why on earth did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

### What qualifies

- **Architectural shape.** "We're using a monorepo." "The write model is event-sourced, the read model is projected into Postgres."
- **Integration patterns between contexts.** "Ordering and Billing communicate via domain events, not synchronous HTTP."
- **Technology choices that carry lock-in.** Database, message bus, auth provider, deployment target. Not every library — just the ones that would take a quarter to swap out.
- **Boundary and scope decisions.** "Customer data is owned by the Customer context; other contexts reference it by ID only." The explicit no-s are as valuable as the yes-s.
- **Deliberate deviations from the obvious path.** "We're using manual SQL instead of an ORM because X." Stops the next engineer from "fixing" something that was deliberate.
- **Constraints not visible in the code.** "We can't use AWS because of compliance requirements." "Response times must be under 200ms because of the partner API contract."
- **Rejected alternatives when the rejection is non-obvious.** If you considered GraphQL and picked REST for subtle reasons, record it — otherwise someone will suggest GraphQL again in six months.
