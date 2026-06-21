---
status: accepted
area: transport
---

# Transports are isolated message buses

Each transport (e.g. `claude-channel`, the Cloudflare `http` transport) owns its own store, and that store is the message bus for the agents on that transport. An agent can only discover and message other agents on the **same** transport; cross-transport messaging is unsupported by design. Agents that need to interoperate must start on the same transport type.

We chose this over a single shared bus spanning all transports because the transports run in different runtimes that cannot share one store: `claude-channel` runs in Bun with `bun:sqlite` against a local file, while the `http` transport runs in Cloudflare's workerd against Durable Object SQLite — workerd cannot open the Bun process's `messages.db`, and Bun cannot reach DO storage. Forcing a unified cross-runtime bus would block the entire true-push effort behind a storage-migration problem. Isolation keeps each transport self-contained and shippable independently.

## Consequences

- A deployment is **homogeneous in transport**: everyone who needs to talk picks the same `--transport`.
- Unifying buses later (if ever) is a deliberate migration, not an incremental change.
- Cross-transport delivery is an explicit non-goal — code and docs should not imply otherwise.
