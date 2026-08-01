# Structured Tool Output and Tool Metadata

**Date:** 2026-07-30
**Status:** Implemented
**Builds on:** 2026-07-29-mcp-v2-stateless-upgrade.md

## What

Adopt two SDK v2 capabilities across all nine messaging tools:

1. **`outputSchema` + `structuredContent`** — every tool declares a zod output
   schema (advertised as JSON Schema in `tools/list`, validated server-side by
   the SDK on every successful result) and returns `structuredContent`
   alongside the JSON text block. Supersedes the parse-JSON-out-of-text-blocks
   convention.
2. **`title` + `annotations`** — human-readable titles and accurate behavior
   hints: `openWorldHint: false` everywhere (octo-santa only touches the local
   shared SQLite database), `destructiveHint: false` everywhere (all writes are
   additive), `readOnlyHint: true` on exactly the three pure list tools, and
   honest idempotency hints. `messaging_read_messages` is deliberately NOT
   read-only — its default mode consumes the unread cursor (read-once).
   Icons are deliberately omitted: octo-santa has no visual surface.

## Result shape contract

Every tool result is a **top-level object** — object-shaped `structuredContent`
projects identically onto the 2025 and 2026-07-28 wire eras (non-object values
get era-dependent `{result: …}` wrapping, verified in the SDK's
`projectCallToolResult`). List results are therefore wrapped in named keys, and
the text block always mirrors `structuredContent` exactly
(`text === JSON.stringify(structuredContent)`):

| Tool | structuredContent |
|------|-------------------|
| messaging_register | `Agent` |
| messaging_create_channel | `Channel` |
| messaging_subscribe | `{subscribed: true, channel}` |
| messaging_list_channels | `{channels: Channel[]}` |
| messaging_send | `Message` |
| messaging_read_messages | `{messages: Message[]}` |
| messaging_list_agents | `{agents: Agent[]}` |
| messaging_list_members | `{members: {agent_id, active}[]}` |
| messaging_rename_channel | `Channel` |

**Breaking change:** the four list-shaped tools previously returned bare JSON
arrays in their text block; they now return the wrapped object. Text and
structured payloads stay identical by construction, so there is exactly one
shape to consume.

Wire schemas live in `src/transports/mcp-stdio/schemas.ts`, tied to the core
domain types two ways: `satisfies z.ZodType<CoreType>` fails compilation when
a core field is removed or renamed, and the contract test
(`tests/hex/transports/tool-metadata.test.ts`) runs every tool against the
real service and validates `structuredContent` with the exact schema the tool
advertises.

Error results (`isError: true`) intentionally carry no `structuredContent`;
the SDK skips output validation for them.

## Verified

- 268 tests pass, `tsc --noEmit` clean.
- End-to-end over real stdio pipes on both eras: `tools/list` advertises
  title/annotations/JSON-Schema outputSchema; `tools/call` returns
  object-shaped `structuredContent` unwrapped on the 2025 wire and the
  2026-07-28 wire alike.
