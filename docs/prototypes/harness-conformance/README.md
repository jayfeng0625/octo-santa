# Harness conformance retained evidence

Generated 2026-08-08T17:28:16.263Z by the disposable exact-pin prototype. This directory is retained classified evidence; raw protocol remains scratch-only and is not committed.

## OpenCode verdicts

| Capability | Classification | Interpretation |
| --- | --- | --- |
| busy-delivery-tool-wait | race-prone | Both ordinary prompt_async messages were accepted and durable while the deterministic tool barrier reported busy, then model-observed before the run became idle. This is not steer and remains terminal-race-prone. |
| harness-managed-follow-up | empirically-verified | A prototype-only wrapper accepted two Deliveries while OpenCode was busy without submitting them, observed authoritative idle, then released one at a time in admission order; each release was HTTP-accepted, model-observed, and completed to idle before the next. |
| two-message-burst-order | empirically-verified | The two busy-admitted delivery nonces were emitted by assistant text in submission order during one runner lifecycle. |
| terminal-race | race-prone | The source-defined terminal snapshot race remains. 0/3 bounded attempts admitted in the post-completion busy window and none reproduced a retained-but-unscheduled row; absence of reproduction is not proof of safety. |
| reconnect-resume-history-backfill | degraded-fallback | Busy-admitted rows survived an abrupt server restart in order, but the new process reported idle and did not automatically resume them; an explicit wake made both nonces model-visible in order. |

## Scope

Executed harnesses: opencode. Rows for harnesses not selected in this retained run preserve documented/unsupported boundaries and otherwise remain unverified; they are not empirical evidence.
Environment-blocked rows: none.

`trace.jsonl` is chronological and uses stable delivery aliases. API acceptance and history durability are separate checkpoints from model observation.
