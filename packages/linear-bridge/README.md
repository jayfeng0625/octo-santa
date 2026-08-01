# linear-bridge

Prototype bridge that turns [Linear](https://linear.app) webhooks into
octo-santa channel messages. It is the first-party consumer of octo-santa's
**admin API**, and it consumes it the honest way: it spawns the admin server
as a subprocess (`bun run packages/octo-santa/src/admin.ts`) and speaks MCP
JSON-RPC over stdio. It never imports octo-santa source code — the only
coupling is the filesystem path used to spawn the server, plus env vars.

## How delivery works

```
Linear ──POST /webhooks/linear──▶ bridge (Bun.serve)
                                    │ verify HMAC signature + replay guard
                                    │ translate event → { content, mentions }
                                    ▼
                          admin_execute over MCP stdio
                                    │ storage.createChannelIfMissing(...)
                                    │ storage.sendMessage({ mentions: ["*"] })
                                    ▼
                            shared SQLite database
                                    │
                every octo-santa agent process watches the DB and
                pushes matching messages to its agent (MCP channel
                notifications); reads remain the poll fallback
```

Delivery is a single `admin_execute` call whose code creates the channel if
missing and sends the message. Because every octo-santa agent process watches
the same SQLite file, nothing else is needed — writing the row *is* the
delivery.

## Handled events

| Event | Message |
| --- | --- |
| `Issue` / `create` | `Linear ENG-123 created: <title> (<state>) <url>` |
| `Issue` / `update` with a state change (`updatedFrom.stateId` present) | `Linear ENG-123 moved to <state>: <title> <url>` |
| `Comment` / `create` | `Comment on ENG-123: <body, first 200 chars> <url>` |

Everything else is acknowledged with `200 {ok:true, ignored:true}` — Linear
retries non-2xx responses, so ignorable events must not error. All handled
events mention `["*"]` (notify everyone in the channel) — prototype scope.

## Setup

1. In Linear: Settings → API → Webhooks → New webhook. Point it at
   `https://<your-host>/webhooks/linear`, enable Issue and Comment events,
   and copy the signing secret.
2. Run the bridge:

   ```bash
   LINEAR_WEBHOOK_SECRET=<secret> OCTO_SANTA_DB=/path/to/shared.sqlite \
     bun run --cwd packages/linear-bridge start
   ```

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `OCTO_SANTA_DB` | octo-santa's default path | Shared database; passed through to the spawned admin server |
| `LINEAR_WEBHOOK_SECRET` | *(unset)* | Webhook signing secret. **If unset, signature verification is skipped with a logged warning — prototype convenience only.** |
| `OCTO_SANTA_BRIDGE_PORT` | `8787` | HTTP port |
| `OCTO_SANTA_BRIDGE_CHANNEL` | `linear` | Channel messages are delivered to |
| `OCTO_SANTA_BRIDGE_SENDER` | `linear-bridge` | Sender name (auto-registered by the admin API) |

### Endpoints

- `POST /webhooks/linear` — webhook receiver. `200 {ok, delivered}` on
  delivery, `200 {ok, ignored}` for unhandled events, `401` on bad
  signature or stale (>60s) `webhookTimestamp`, `502` if delivery to the
  admin server fails (so Linear retries).
- `GET /healthz` — liveness check.

## Prototype status

This is a proof that the admin surface works for an external app, not a
production service. Known simplifications: everyone-mentions on every event,
delivery happens inline in the request (no queue), the admin subprocess is
restarted lazily on the next request after a crash, and skipped verification
when no secret is set.

## Tests

```bash
bun test packages/linear-bridge   # from the repo root
```

The admin-client and integration tests spawn the real admin server against a
temp database — they cover discovery (`admin_search`), execution, out-of-order
response matching, error surfacing, subprocess restart, and the full
webhook-to-SQLite path.
