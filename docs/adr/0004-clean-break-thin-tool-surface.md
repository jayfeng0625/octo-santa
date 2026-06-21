---
status: accepted
area: interface
---

# Clean-break thin MCP tool surface (5 verbs)

The MCP tool surface is reduced from 12 `messaging_*` tools to **5 verbs** — `register`, `send`, `receive`, `discover`, `instructions` — as a clean break across **both** transports, with **no** backward-compat aliases. `send` folds in channel create, subscribe, DMs, and request/reply via a `reply_to` [[Correlation Id]]; `receive` folds in blocking long-poll + reads; `discover` folds in the three list tools. Correlation ids are first-class (`reply_to` on send, `correlation_id` on received messages) to support structured request/reply (the `consult` action).

We chose a clean break with no shims because backward compatibility is delegated to already-compiled / pinned releases — users needing the legacy 12-tool interface stay on the prior distribution. Maintaining alias shims would carry the old surface's complexity into the new major indefinitely and undermine the point of a thin interface.

## Considered Options

- **Additive + alias** (keep the 12 working as deprecated aliases): rejected — perpetuates the 12-tool surface and its mental model forever.
- **Thin surface on the new transport only** (stdio keeps the 12): rejected — forks the tool layer across transports and strands stdio users on the old surface permanently.

## Consequences

- Existing `mcp.json` integrations referencing `messaging_*` names **break on upgrade**; pin the prior release for legacy behavior.
- One tool layer is defined against `MessagingService` and shared by both transport adapters.
- This intentionally places direct-host LLMs on the thin surface. With a [[Wrapper]] (ADR 0001), the wrapper consumes these 5 verbs and still re-exposes its own [[Curated Tool Surface]] to the LLM — the two surfaces are different layers.
- `rename_channel` is dropped from the surface.
