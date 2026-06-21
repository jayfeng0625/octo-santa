---
status: accepted
area: transport
---

# Cloudflare MCP server + single bus Durable Object for the `http` transport

The alternative transport (the one offered alongside `claude-channel`) is a Cloudflare MCP server over **Streamable HTTP**, backed by a **single bus Durable Object** that owns DO-SQLite and holds every connected agent's live stream. It runs locally on Miniflare (`wrangler dev`) and deploys to Cloudflare for private-network messaging. Context injection on this transport is via a **blocking `receive` tool result** (ubiquitous across harnesses), not host-surfaced notifications.

We chose Cloudflare over rolling our own HTTP server because it lets us delegate the infrastructure leg-work — durability, WebSocket/stream hibernation, networking, auth, deployment — and Miniflare's local runtime is functionally identical to production, so local-first is preserved. HTTP (which stdio cannot do) is what enables agents across a private network to share one bus. A single bus DO is chosen because messaging is a bipartite agent×channel relation: sharding by either axis splits the relation and forces cross-DO RPC, so for local/small-team scale the un-sharded single DO gives zero-RPC, zero-poll in-memory fan-out.

## Considered Options

- **Plain Node Streamable-HTTP server**: simpler runtime, reuses the local-file SQLite adapter. Rejected — it reinvents durability, hibernation, networking, and deployment that Cloudflare already provides; Miniflare gives the same local ergonomics without that work.
- **Channel-sharded DOs (one DO per channel)**: natural state boundary, but connections are per-agent (one stream multiplexes all channels), so a channel DO cannot hold its members' streams — forcing a separate per-agent connection DO plus cross-DO RPC fan-out. Deferred to a future scale-out, not adopted now.
- **Host-surfaced notifications for injection**: rejected as the primary path — most non-Claude hosts don't inject server notifications into context; only a blocking tool result is guaranteed everywhere.

## Consequences

- The worker runs on **workerd**, not Bun/Node — no `bun:sqlite`, no local-file access on this transport. Storage is **DO-SQLite** (a new storage adapter); the existing `bun:sqlite` repos serve only the `claude-channel` transport.
- Per ADR 0002, this transport is its own isolated [[Message Bus]] — agents on it cannot message `claude-channel` agents.
- `notifications/claude/channel` push does **not** apply over Streamable HTTP; the `claude-channel` capability is stdio-only.
- Selection is split: `--transport` is a flag on the stdio binary; the Cloudflare transport is run separately (Miniflare/wrangler) and connected by `url` in `mcp.json`.
- The codebase must be de-Bun'd (drop `bun:sqlite`/`Bun.*` refs, build with Bun, run on Node/workerd) so core is portable across both transports' runtimes.
