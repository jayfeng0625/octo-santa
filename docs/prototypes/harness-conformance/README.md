# Harness conformance retained evidence

Generated 2026-08-08T17:16:40.418Z by the disposable exact-pin prototype. This directory is retained classified evidence; raw protocol remains scratch-only and is not committed.

## OpenCode verdicts

| Capability | Classification | Interpretation |
| --- | --- | --- |
| harness-managed-follow-up | empirically-verified | Two follow-ups were submitted and persisted while the session was demonstrably busy, then released to the model in order within the same busy-to-idle lifecycle. No repeated idle wake was used. |
| two-message-burst-order | empirically-verified | The two busy-admitted delivery nonces were emitted by assistant text in submission order during one runner lifecycle. |
| terminal-race | race-prone | The source-defined terminal snapshot race remains. 0/3 bounded attempts admitted in the post-completion busy window and none reproduced a retained-but-unscheduled row; absence of reproduction is not proof of safety. |
| reconnect-resume-history-backfill | degraded-fallback | Busy-admitted rows survived an abrupt server restart in order, but the new process reported idle and did not automatically resume them; an explicit wake made both nonces model-visible in order. |

## Scope

Executed harnesses: opencode. Rows for harnesses not selected in this retained run preserve documented/unsupported boundaries and otherwise remain unverified; they are not empirical evidence.
Environment-blocked rows: none.

`trace.jsonl` is chronological and uses stable delivery aliases. API acceptance and history durability are separate checkpoints from model observation.
