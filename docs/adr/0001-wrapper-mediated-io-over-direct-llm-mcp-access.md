# Wrapper-mediated I/O over direct LLM MCP access

When building agents that interact with octo-santa, the LLM does not get direct access to MCP tools. Instead, a deterministic wrapper mediates all external communication — the LLM produces structured decisions (search, ask, answer, clarify) and the wrapper translates those into MCP calls, handles registration/subscription lifecycle, manages timeouts and retries, and returns plain results back to the LLM.

We chose this over giving the LLM direct MCP tool access because: (1) the LLM doesn't need to reason about protocol mechanics like registration, subscriptions, or message polling — that complexity degrades LLM performance without improving outcomes; (2) failure handling stays deterministic — infrastructure errors (timeouts, unreachable services) are handled by the wrapper, while content-level failures (insufficient context) flow naturally through the LLM's normal reasoning; (3) the curated tool surface (3-4 domain-level actions vs 15+ raw MCP tools) produces more reliable structured output; (4) schema-enforced structured output at the SDK boundary eliminates malformed responses entirely.

## Considered Options

- **Direct MCP access**: Give the LLM all octo-santa MCP tools and let it call them freely. Simpler to wire up, but the LLM would need to manage registration state, understand polling semantics, and handle protocol-level errors — all of which are deterministic concerns that don't benefit from LLM reasoning. Higher token cost, worse reliability.

- **Hybrid**: Expose some safe MCP tools directly (read-only queries) while wrapping others. Rejected because the boundary between "safe to expose" and "must wrap" shifts over time and creates a confusing mental model for both the developer and the LLM.

## Consequences

- Every new octo-santa capability requires a wrapper-side implementation before the LLM can use it. This is intentional — it forces deliberate tool design rather than automatic exposure.
- The curated tool surface becomes the contract between the wrapper and the LLM. Changes to this surface require updating both the tool implementations and the static core prompt.
