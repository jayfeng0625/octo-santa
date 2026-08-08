# Pinned harness control surfaces and observable delivery semantics

> Research question: GitHub issue #53, “Research pinned harness control surfaces and observable delivery semantics”
>
> Date: 2026-08-08
>
> Scope: primary first-party documentation and indexed first-party source only. No conformance prototype was run.

## Executive conclusion

The four harnesses do not offer interchangeable delivery semantics.

- **Pi is the only candidate with separately named, documented, and source-traced steering and follow-up queues.** A steering message is inserted after the current assistant turn and its tool calls but before the next model call; a follow-up is inserted only when the agent would otherwise stop.
- **Codex App Server has a real same-turn steering primitive, but it does not alter an already-running provider sample.** `turn/steer` accepts input into the active regular turn's pending-input queue. Source drains that queue, records it into history, and builds another model request. The response means the active turn accepted the input, not that the current sample saw it.
- **OpenCode server/SDK has no steering primitive.** A prompt submitted while busy is saved before joining the already-running session runner. If the active loop has another iteration, it can reread and use that message; if the current assistant finishes normally, the loop can exit without rereading it. The first-party app avoids this ambiguity with a client-side follow-up queue that waits for session idle before calling the ordinary prompt API.
- **Claude Code exposes enough queue receipts and lifecycle telemetry to build a serious probe, but not enough public implementation to prove model visibility statically.** The pinned SDK documents queued command lifecycle, queued-message interrupt receipts, origin on results, transcript access, and resume controls. The SDK wrapper source proves frames are written and events are read; the Claude Code ingestion and provider-request construction path is not public. Every visibility claim therefore remains empirical.

The later harness should advertise capabilities independently:

1. `wake`: proven idle input that starts work.
2. `steer`: proven busy input observed before the active logical turn completes.
3. `follow_up`: proven ordered input held until idle and then started.
4. `origin`: structured origin survives to observations and, separately, whether any origin is model-visible.
5. `reply`: output can be correlated to the triggering delivery without relying only on wall-clock order.

API success, queue insertion, persistence, lifecycle emission, and model-visible observation are five different checkpoints. This report never treats an earlier checkpoint as proof of a later one.

## Evidence method

Evidence labels used below:

- **D**: documented guarantee in pinned first-party material.
- **S**: behavior observed in pinned first-party source, but not necessarily a public compatibility promise.
- **U**: unknown without an empirical probe, or unavailable in public source.
- **N/A**: the surface is not intended to provide that semantic.

“Model-visible” means the content is included in an actual provider request or is demonstrated by model behavior. A user-message event, transcript row, queue receipt, or successful HTTP/RPC response is not sufficient by itself.

## Candidate pins

| Harness | Candidate pin for probe | Why this pin | Source identity |
| --- | --- | --- | --- |
| Claude Code | `@anthropic-ai/claude-code` 2.1.226 with `@anthropic-ai/claude-agent-sdk` 0.3.226 | The SDK changelog says 0.3.226 is at parity with Claude Code 2.1.226. Pin both because the SDK wire types and bundled executable move together. | Claude Code tag `v2.1.226`; Agent SDK tag `v0.3.226` [C1] |
| Codex App Server | `@openai/codex` / Rust workspace 0.147.0 | The repository workspace version and release tag agree. App Server protocol and implementation are in the same tagged tree. | `rust-v0.147.0`, commit `be6e8eac029b183056b7e4402879f15d2c85f61b` [X1] |
| Pi RPC/SDK | `@mariozechner/pi-coding-agent` 0.73.1 | RPC docs, SDK docs, core agent loop, and package version are in one tagged monorepo snapshot. | `v0.73.1`, commit `781152fc24841dc54b22284514604048ebe5e2c9` [P1] |
| OpenCode | `opencode-ai`, `@opencode-ai/sdk`, and `@opencode-ai/plugin` 1.18.15 | Server, generated SDK, plugin types, TUI, and app follow-up queue are version-aligned in one tag. | `v1.18.15`, commit `d7b115f623760e68a4749d16508a9eca350f246f` [O1] |

The Python Claude Agent SDK 0.2.134 is used only as readable supplemental wrapper-source evidence. It is not substituted for the 0.3.226 TypeScript probe pin, and any difference is treated as version-sensitive [C2].

## Compact findings matrix

### Delivery controls

| Harness | Idle input | Busy steering | Follow-up queue | Origin metadata | Model-visible observation |
| --- | --- | --- | --- | --- | --- |
| Claude Code 2.1.226 | **D/S:** string or streamed user messages; long-lived SDK client | **D:** messages can be sent dynamically; queued command lifecycle and interrupt receipts exist. **U:** exact busy placement and visibility | **D:** queued async messages exist and have lifecycle/cancel receipts. **U:** no public steer-vs-follow-up placement contract | **D:** result `origin`; task-notification subkinds include peer-send and scheduled trigger. **U:** full ordinary-input origin preservation and model visibility | **U:** public wrapper proves transport write and event read, not CLI ingestion into a provider request |
| Codex 0.147.0 | **D:** `turn/start` | **D/S:** `turn/steer` on an active regular turn; source queues for a later sampling boundary | **U:** no dedicated follow-up primitive. Client can wait for `turn/completed`, then `turn/start` | **D:** optional `clientUserMessageId` echoes as user item `clientId`; thread has a source. No sender-kind field | **D:** `thread/inject_items` is explicitly model-visible. **S:** steer is recorded before the next model request. Acceptance alone is still insufficient |
| Pi 0.73.1 | **D/S:** RPC `prompt` or SDK `prompt()` | **D/S:** explicit `steer`; after current assistant/tool turn, before next LLM call | **D/S:** explicit `follow_up`; only after no tools or steering remain | **D/S:** `InputSource` reaches extension input hooks; custom messages retain `customType` in app history. **S:** both are removed from the model form unless encoded in content | **D/S:** queue contract says messages are added before the next LLM call; source pushes them into context before streaming the next assistant response |
| OpenCode 1.18.15 | **D/S:** synchronous prompt, `prompt_async`, or `noReply` context insertion | **U / unsupported as a server contract:** no steer endpoint. Busy prompt has a source-observed terminal race | **S:** first-party app queues locally and waits for idle; server/SDK itself has no queue API | **S:** client message ID and assistant `parentID` exist; no sender-kind field. Part metadata is not lowered into model input | **D/S:** `noReply` is documented as context-only and source lowers stored text into model messages on a later loop. Busy/async acceptance remains unproven |

### Observation and continuity

| Harness | Lifecycle events | Session history | Compaction/resume | Replies and correlation |
| --- | --- | --- | --- | --- |
| Claude Code | **D:** init/result, assistant stream, hook events, background-task level, `command_lifecycle` states | **D/S:** paginated `getSessionMessages`; optional system and hook events; JSONL transcript in Python source | **D:** resume, point resume with drop guard, fork, rewind; SessionStart distinguishes fork/resume. **U:** exact pre-compaction visibility preservation | **D:** user UUID, result UUID/origin, terminal reason. **U:** no general `replyTo` contract for arbitrary inbound messages |
| Codex | **D:** thread, turn, item, delta, status, token, compact, error events | **D:** `thread/read`, paginated turns/items, user/agent item IDs | **D:** resume, fork with boundaries, manual/automatic compaction, rollback marker | **D:** turn/item IDs and optional client user ID; agent messages belong to a turn. `tool/requestUserInput` has a structured client response, but only when Codex asked |
| Pi | **D:** agent/turn/message/tool/queue/compaction/retry events | **D/S:** `get_messages`, `AgentSession.messages`, JSONL tree, deterministic context build | **D:** compact; runtime new/switch/fork/import; context builder applies compaction summary and retained tail | **U:** RPC response IDs acknowledge commands, but streamed events explicitly have no request ID. No native arbitrary-message `replyTo` |
| OpenCode | **D/S:** SSE and plugin events for message/session/status/idle/compacted/error | **D/S:** list/get messages with message and part IDs; persisted session is addressed by ID | **D/S:** summarize/automatic compaction, fork, and continued prompting of an existing session ID; no separate resume handshake | **S:** assistant `parentID` points to user ID, yielding native per-message correlation. Async submission still needs lifecycle confirmation |

## Claude Code 2.1.226 / Agent SDK 0.3.226

### Documented guarantees

- SDK 0.3.226 declares parity with Claude Code 2.1.226 [C1]. The current supported multi-turn shape is `query()` with an `AsyncIterable<SDKUserMessage>`; continuation uses `options.resume` [C3].
- The SDK's long-lived client is documented as bidirectional, stateful, able to send messages at any time, and able to interrupt [C4]. This describes client capability, not busy-message placement inside Claude Code.
- Stream/SDK sessions emit `command_lifecycle` frames for UUID-stamped messages with `queued`, `started`, `completed`, `cancelled`, or `discarded` terminal progression [C5].
- `Query.interrupt()` can return `still_queued`; `system/init` advertises support with `interrupt_receipt_v1`. A later capability adds `cancel_queued` for queued and pending-dispatch messages [C5]. These are queue and cancellation receipts, not model-observation receipts.
- Result messages carry the triggering message's `SDKMessageOrigin`, distinguishing user-prompted results from task-notification follow-ups. Current task-notification subkinds include scheduled triggers and cross-session `SendMessage` notifications [C6].
- Session history is readable with pagination. It can optionally include system messages and hook lifecycle messages [C7].
- Resume controls include ordinary resume, `resumeSessionAt`, a `resumeDropsTurn` truncation guard, forking, and conversation rewind with a durable resume anchor [C1] [C8].
- Hook types include prompt, stop, compact, notification, tool, permission, and subagent lifecycle events. Several hook outputs can add context [C9].

### Source-observed behavior

- In the readable Python SDK wrapper, a string prompt is serialized as a `type: "user"` frame with a user-role message, `parent_tool_use_id`, and session ID, then written to the transport. Later calls do the same, and streamed iterables are written frame by frame [C10].
- `interrupt()` sends an `interrupt` control request and waits for its control response [C11].
- The wrapper reads output frames and parses them into typed messages. Its transcript reader builds a parent-linked conversation chain and returns chronological user/assistant messages [C12].
- The wrapper keeps stdin open past a turn result while background tasks remain because a result ends one turn, not necessarily the whole run [C13]. This matters when defining idle.

### Unknowns and non-guarantees

- The public Claude Code repository does not expose the CLI engine source that accepts stream-json user frames, schedules them, builds provider requests, or persists them. The wrapper write is therefore the end of the public source trace.
- “Send messages at any time” does not say whether a busy message steers before the next model call, starts a later turn, coalesces with siblings, or can miss a terminal race.
- `command_lifecycle: started` means the command entered execution. It is not proof that the model received its content.
- Transcript presence and replayed user-message output prove persistence/echo, not provider-request inclusion.
- Result `origin` proves output-side attribution where populated. It does not establish that origin metadata itself was visible to the model.
- Cross-session auto-delivery and scheduled task notifications are documented in the SDK changelog, but the public external ingress API and their exact busy/idle placement are not available in indexed source at this pin.
- No general arbitrary-message `replyTo` field is documented. Correlation candidates are message UUID, result UUID, result origin, session ID, and command lifecycle.

### Plausible later probe paths

1. One-shot `query()` with a string prompt while idle.
2. `query()` with an async iterable and one initial SDK user message.
3. A long-lived `ClaudeSDKClient`, sending a second user message only after the first result.
4. The same client, sending a second user message during assistant streaming.
5. Multiple busy messages with unique UUIDs, observing every `command_lifecycle` transition and result origin.
6. Busy message followed by ordinary interrupt, recording `still_queued` and subsequent execution.
7. Busy messages followed by capability-gated `cancel_queued`, proving which UUIDs are cancelled versus retained.
8. Resume by session ID followed by a marker prompt; separately resume at a point with `resumeDropsTurn`.
9. Fork and rewind paths followed by a marker prompt to establish which history branch becomes model context.
10. `getSessionMessages()` and raw stream replay as persistence observations, never as sole visibility oracles.
11. `UserPromptSubmit`, `SessionStart`, `Notification`, and tool hooks that return a unique `additionalContext` marker, with a model echo assertion.
12. Cross-session `SendMessage`, scheduled-trigger notification, and Remote Control inbound paths if the pinned SDK exposes a supported host-side ingress at probe time. Each must be tested separately because their origins differ.
13. Permission/tool control responses only in response to a live server request. They are not substitutes for arbitrary user delivery.
14. SDK custom transport/direct stream-json framing to compare wrapper behavior with the supported SDK path; do not advertise it if it relies on an internal frame shape.

## Codex App Server 0.147.0

### Documented guarantees

- A connection initializes once, then starts or resumes a thread. `turn/start` immediately returns an initial turn object, while `turn/started` marks actual execution and `turn/completed` marks completion/interruption/failure [X2].
- `turn/start` adds user input and starts generation. Optional `clientUserMessageId` is echoed on the corresponding user item as `clientId` [X3].
- `turn/steer` adds input to an already in-flight regular turn without starting a new turn and returns the active turn ID that accepted it. `expectedTurnId` is required. Review and manual compaction turns reject steering [X3] [X4].
- `thread/read` reports `canAcceptDirectInput` for loaded threads, covering acceptance of `turn/start` and `turn/steer`; unloaded history reports unknown [X3].
- There is no documented dedicated follow-up queue. The contract-safe follow-up is client orchestration: wait for `turn/completed`, then call `turn/start`.
- `thread/inject_items` explicitly appends raw Responses API items to model-visible history without starting a user turn [X3]. This is the strongest documented visibility statement among the four candidates.
- `thread/read`, `thread/turns/list`, and `thread/items/list` expose history. Resume appends future turns to the existing thread; fork copies bounded history [X3].
- Manual compaction returns immediately and emits standard turn/item progress with a `contextCompaction` item; compaction can also occur automatically [X5].
- Turn and item lifecycle is explicit. Every item follows `item/started`, zero or more deltas, then `item/completed`; completion is authoritative for item execution state [X6].
- A model-initiated `tool/requestUserInput` is a server request with a structured client response and a later `serverRequest/resolved` notification [X7]. It is a reply path only for a question Codex already asked.

### Source-observed behavior

- `turn/steer` validates direct input, expected active turn ID, size, and input shape before calling `steer_input`; it reports no-active-turn, ID mismatch, and non-steerable turn errors distinctly [X8].
- Core accepts steering only for an active regular task. It stores additional context plus a user input carrying the optional client ID in the active turn's pending queue, then returns the active turn ID [X9].
- The run loop drains pending input only at a sampling boundary. It runs prompt hooks, records user input into history, clones that history for the next provider request, and requests another sample when pending input exists [X10]. The source itself warns that UI submission while the model is running does not imply the model supports immediate observation [X10].
- Consequently, steering does not modify the request already in flight. It becomes visible, if accepted through this path, in a later provider request in the same logical turn.
- `turn/start` submits asynchronously and returns a synthetic in-progress turn before Core has necessarily admitted or started it [X11]. Core's generic user-input handler can steer an existing turn or start a new one [X12]. The App Server documentation does not promise `turn/start`-while-busy behavior, so that path remains source-sensitive and must not be advertised without a probe.
- Assistant messages are created with a turn-local parent user context; turn/item IDs and client IDs provide correlation, but there is no general sender principal or origin-kind field on user input. Responses API client metadata is transport metadata, not documented model-visible content [X13].

### Unknowns and non-guarantees

- A successful `turn/steer` response proves queue insertion into the active regular turn, not that the current provider sample saw the input.
- The boundary race between final sampling, queue insertion, and turn completion needs empirical coverage even though source intends a follow-up sample for pending input.
- `turn/start` while another turn is active is not a documented follow-up queue. Source routes generic user input through an admission path that may steer, but the returned App Server turn ID and event sequence need conformance evidence.
- `clientUserMessageId` is correlation, not authenticated origin. Thread `source` identifies the creating client class, not each sender.
- `thread/inject_items` is documented as model-visible history, but its persistence/replay behavior, ordering against an active sample, and safe item variants require a probe before using it as delivery.
- No ordinary assistant item contains a general `replyToClientUserMessageId`; correlation is through turn membership and user/assistant item IDs.

### Plausible later probe paths

1. Idle `turn/start` with unique `clientUserMessageId`.
2. `turn/steer` during streamed text with matching `expectedTurnId`.
3. `turn/steer` during a tool call, verifying observation only in the next provider sample.
4. Multiple steers in one regular turn, checking order and distinct echoed client IDs.
5. `turn/start` while a regular turn is active, treated as an experimental candidate rather than a contract.
6. Client-managed follow-up: wait for authoritative `turn/completed`, then `turn/start`.
7. `thread/inject_items` while idle, followed by `turn/start` asking the model to report the marker.
8. `thread/inject_items` while busy, checking whether it joins the active turn, only later history, or is rejected.
9. `thread/shellCommand` during an active turn; docs say formatted output enters the active message stream, but it is not a neutral user-message path [X3].
10. `tool/requestUserInput` response, only after a matching server request.
11. `turn/interrupt`, requiring terminal `turn.status: interrupted`, then a clean follow-up turn.
12. `thread/resume`, bounded `thread/fork`, rollback, and manual compaction followed by marker-recall checks.
13. `thread/read`, paginated turns, and paginated items as persistence/correlation observations.
14. Realtime `thread/realtime/appendText` as a separate realtime-model surface, never assumed equivalent to regular Codex turn input [X3].
15. Inter-agent/collaboration `send_input` only as a separately classified agent-origin path; it is not a generic external sender ingress.

## Pi RPC/SDK 0.73.1

### Documented guarantees

- RPC responses are emitted after a prompt is accepted, queued, or handled. Success explicitly does not mean downstream completion; failures after acceptance arrive through events/messages [P2].
- A busy RPC `prompt` must select `streamingBehavior: "steer"` or `"followUp"`; omission is an error. Direct `steer` and `follow_up` commands expose the same queues [P2].
- Steering is delivered after the current assistant turn finishes its tool calls and before the next LLM call. Follow-up is delivered only when the agent has no more tool calls or steering messages [P2].
- Queue modes support all-at-once or one-at-a-time delivery [P3].
- The SDK exposes the same `prompt`, `steer`, `followUp`, event subscription, state, abort, compact, and message-history controls [P4].
- RPC `get_state` includes streaming, compacting, queue modes, session identity, message count, and pending-message count. `get_messages` returns the conversation [P5].
- Stream events cover agent, turn, message, tool, queue, compaction, retry, and extension error lifecycles. RPC events explicitly do not include request IDs; only command responses do [P6].
- Runtime-level new/switch/fork/import operations replace the active `AgentSession`; callers must re-subscribe and rebind extensions [P4].
- Session context walks the selected JSONL tree branch. When compacted, it emits the summary, retained suffix, and later messages in a defined order [P7].

### Source-observed behavior

- RPC `prompt` emits its success response from a preflight callback and continues the accepted run asynchronously. Direct `steer` and `follow_up` await queue insertion, then return success [P8].
- `AgentSession.steer()` and `followUp()` turn content into timestamped user messages and push them into separate core queues [P9].
- The core agent loop drains steering after an assistant response and its tool calls, appends each queued message to conversation context, then starts another assistant response. It checks follow-ups only after tool calls and steering are exhausted [P10].
- The low-level contract explicitly says steering messages are added to context before the next LLM call and follow-ups are added when the agent would otherwise stop [P11]. This is a complete public-source trace from queue API to model context construction.
- Extension `sendUserMessage()` uses ordinary prompt handling with source `extension`. Extension `sendMessage()` can create a custom message delivered as steer, follow-up, or next-turn, optionally waking an idle agent [P12].
- `InputSource` is only `interactive`, `rpc`, or `extension` and is supplied to extension input handlers [P13]. Ordinary queued user messages do not retain that field.
- Custom messages preserve `customType`, display, and details in application/session state, but conversion to LLM messages maps them to a plain user message containing only content and timestamp. `customType` and details are not model-visible unless the extension encodes them into content [P14].

### Unknowns and non-guarantees

- RPC command ID correlates only the acceptance response. Since events carry no ID, a harness must correlate later user/assistant messages by content, queue snapshots, and strict sequencing unless it wraps messages with its own marker.
- `InputSource` is coarse and extension-facing; it is neither authenticated principal metadata nor a persisted per-message origin.
- No native arbitrary-message `replyTo` identifier is documented. `turn_end` carries the assistant message and tool results, but not the RPC request ID.
- Queue behavior across abort, auto-compaction, session replacement, process crash, and resume is not fully specified. Source shows in-memory queues; durable queue recovery is not promised.
- Extension commands execute immediately even while streaming and manage their own LLM interaction. They are not equivalent to either queue and must be probed separately if admitted.

### Plausible later probe paths

1. Idle RPC `prompt`.
2. Busy RPC `prompt` with `streamingBehavior: steer`.
3. Busy RPC `prompt` with `streamingBehavior: followUp`.
4. Direct RPC `steer`.
5. Direct RPC `follow_up`.
6. Multiple queue entries under both all-at-once and one-at-a-time modes.
7. SDK `AgentSession.prompt`, `steer`, and `followUp` without a subprocess.
8. Extension `pi.sendUserMessage()` while idle and with each busy delivery mode.
9. Extension `pi.sendMessage()` as steer, follow-up, and next-turn, with and without `triggerTurn`.
10. Extension command through RPC `prompt` while busy, classified separately because it bypasses normal queue placement.
11. Direct core `Agent.steer()` and `Agent.followUp()` only if the final adapter intentionally targets the lower-level package.
12. Abort with queued messages, followed by `get_state`, `queue_update`, and `get_messages` checks.
13. Manual/automatic compaction with queued messages and unique pre/post-compaction markers.
14. Runtime new session, switch, fork, and import followed by re-subscription and marker recall.
15. Process restart with a persisted session to establish that history resumes while in-memory queue contents do not silently masquerade as durable delivery.

## OpenCode server/SDK/plugin 1.18.15

### Documented guarantees

- The server exposes synchronous message submission, asynchronous `prompt_async`, message history, session status, abort, fork, summarize, and session/event streams [O2].
- Synchronous prompt waits for an assistant response by default. `noReply: true` returns the user message as context only. `prompt_async` returns no content immediately [O2] [O3].
- The SDK documents the same session methods. Its `noReply` example explicitly injects context without triggering an AI response [O3].
- TUI control endpoints append text to the editor and submit the current prompt, but their boolean response is only UI command publication [O4].
- Server SSE begins with `server.connected` and then streams bus events. Plugin event documentation includes message updates, session status/idle/compacted/error, permissions, tools, and TUI events [O4] [O5].
- Plugin code receives an SDK client. `chat.message` can mutate a newly received user message and parts before save; `experimental.chat.messages.transform` can mutate the history immediately before model-message conversion; `experimental.chat.system.transform` can mutate system strings [O6].
- Compaction hooks can modify the compaction prompt/context and can disable the synthetic post-compaction continue turn [O7].

### Source-observed behavior

- Prompt handling creates and persists the user message before it enters the session loop. `noReply` returns immediately after persistence; otherwise it joins `loop()` [O8].
- `prompt_async` forks the entire prompt effect and returns a no-content response. Errors after the fork are emitted as session error events [O9]. The HTTP acknowledgement therefore does not even prove persistence has completed.
- Per-session execution uses one `Runner`. `ensureRunning()` starts work when idle, but when already running it waits for and returns the existing run; it does not schedule the newly supplied work [O10].
- The model loop rereads compacted history at the top of each iteration, finds the latest user message, lowers history to model messages, and sends it to the processor [O11]. If a new busy prompt lands before another iteration, it can be included.
- The same loop exits immediately when the current assistant has a terminal finish and is parented by the latest user known at that iteration [O11]. A concurrent prompt persisted after that history snapshot can therefore remain in history without receiving an assistant child. This is a real terminal race, not a supported steering contract.
- The first-party app implements follow-up queueing outside the server. When configured to queue and the session is busy, it stores a client-side draft. An effect sends the first draft only after session state is no longer busy [O12].
- The TUI endpoint publishes prompt-append and prompt-submit events. The TUI inserts text, then its normal submit path calls the ordinary session prompt API; the endpoint's `true` response is not delivery confirmation [O13].
- Before every provider call, `experimental.chat.messages.transform` runs, then stored messages are converted. User conversion includes text/file content but not arbitrary part metadata [O14].
- Assistant messages created by the loop carry `parentID: lastUser.id`, giving a native reply edge from assistant to user message [O11].
- Compaction publishes `session.compacted`, inserts a synthetic continue user turn unless disabled, and later model context is built through the compacted-history projection [O15].

### Unknowns and non-guarantees

- There is no server or SDK `steer` endpoint at this pin.
- A successful synchronous prompt while busy can return the active run's assistant result even though the newly persisted user message was not observed. A `204` from `prompt_async` is weaker still.
- The app follow-up queue is client-local behavior, not a server durability guarantee. Its survival across app restart, tab closure, reconnect, and multi-client contention is not established here.
- Session status idle is an observable scheduling gate, but a client that sees idle and sends a prompt still needs message/lifecycle confirmation for race-free delivery.
- User message ID and assistant parent ID provide correlation, not authenticated sender origin. User message model/agent fields select execution; they do not identify a principal.
- Part metadata can carry UI/source information in storage, but the model lowering shown at this pin includes text/file content rather than arbitrary metadata. Metadata is not model-visible unless encoded into admitted text/system content.
- `chat.message` and experimental transforms run in-process and may create model-visible content, but they are mutation hooks, not spontaneous wake mechanisms. A plugin still needs an external trigger and an SDK prompt call.
- Continued use of an existing session ID acts as resume, but there is no separate resume acknowledgement defining what in-memory runtime state is restored.

### Plausible later probe paths

1. Idle synchronous session prompt with a client-supplied message ID.
2. Idle `prompt_async`, requiring later `message.updated`, assistant child, and idle events before success.
3. `noReply` insertion followed by a separate ordinary wake prompt.
4. Direct synchronous prompt while busy, specifically testing the final-sample terminal race.
5. Direct `prompt_async` while busy, with the same race and weaker acknowledgement.
6. Harness-managed follow-up: observe `session.status`/`session.idle`, then submit the ordinary prompt and verify the assistant `parentID`.
7. First-party app queue behavior as a reference probe, including multiple drafts and ordering.
8. TUI `append-prompt` followed by `submit-prompt`, observing whether the active UI is disabled, queues locally, or calls the busy server path.
9. Session `command` and shell paths, classified separately from ordinary user delivery.
10. Plugin calling its provided SDK client's synchronous prompt while idle.
11. Plugin calling `prompt_async` while idle and busy.
12. `chat.message` mutation that appends a unique text origin marker, then verifies storage and model echo.
13. `experimental.chat.messages.transform` insertion of a unique user-content marker immediately before model lowering.
14. `experimental.chat.system.transform` insertion of a unique system marker, tested separately from user delivery.
15. Plugin custom tool return as model-visible tool output only after the model calls the tool; never advertise it as external wake or steer.
16. Fork, summarize/automatic compaction, and continued prompting of an existing session ID with pre/post-boundary markers.
17. SSE disconnect/reconnect and message-history backfill to distinguish transient events from durable state.
18. Two clients submitting to one session to expose runner joining, ordering, and parent-correlation behavior.

## Required empirical oracle design

The later conformance harness should use the same cross-harness assertions, while adapting only the control call and event names.

### Checkpoints per delivery

1. **Submitted:** the client wrote the request/frame.
2. **Accepted:** the harness returned success or an acceptance receipt.
3. **Durable:** session history contains the exact delivery ID and body after a reconnect/restart boundary where supported.
4. **Scheduled:** a queue/lifecycle event identifies the delivery as queued or started.
5. **Observed:** the model emits a deterministic acknowledgement containing a nonce that was available only in that delivery.
6. **Replied:** the assistant result has a native or wrapper-attested edge back to that delivery ID.
7. **Completed:** terminal lifecycle says completed rather than cancelled/discarded/interrupted/failed.

No checkpoint implies the next one.

### Scenarios

1. Idle marker delivery.
2. Busy delivery during text streaming.
3. Busy delivery during a deterministic long-running tool call.
4. Two ordered steering candidates.
5. Two ordered follow-up candidates.
6. Interrupt with queued input.
7. Origin metadata varied while body text remains identical.
8. Reply correlation with two deliveries close together.
9. Compaction between delivery and observation.
10. Resume/restart between persistence and follow-up.
11. Event-stream disconnect followed by history backfill.
12. Negative case: accepted but deliberately cancelled/discarded, proving the harness does not false-accept visibility.

The model-visible oracle must ask the model to return the nonce and, separately, the origin fields it can actually see. Origin should be supplied structurally and omitted from body text in that test. If the model cannot report it, the adapter may still expose transport-visible origin while declaring model-visible origin unsupported.

## Capability recommendation before probing

| Harness | Safe initial claim from research alone | Claims withheld pending probe |
| --- | --- | --- |
| Claude Code | Candidate `wake`; rich lifecycle/history candidate | `steer`, `follow_up`, model-visible origin, durable queued delivery |
| Codex | Candidate `wake`; documented same-turn steer surface; model-visible raw history injection | Race-free `steer`, `turn/start` busy behavior, durable follow-up queue |
| Pi | Candidate `wake`, `steer`, and `follow_up`; strongest static case | Queue durability across abort/compaction/restart; reply correlation; model-visible origin |
| OpenCode | Candidate `wake`; harness-managed `follow_up` by idle gating | Native `steer`; direct busy prompt; durable server-side queue; model-visible origin |

This preserves the map's settled OpenCode position: begin with `wake` plus `follow_up`; inability to prove `steer` does not block the gateway.

## Unresolved gaps

1. Claude Code's queue scheduler and provider-request construction are not public at the pinned release. Static research cannot close visibility or placement.
2. Claude Agent SDK's public repository at 0.3.226 provides release documentation but not the bundled TypeScript engine source/type artifact in indexed source. The readable Python wrapper is a supplemental, older pin.
3. Claude cross-session `SendMessage`, scheduled triggers, and Remote Control expose origin/lifecycle hints but not a fully documented host-side ingress contract suitable for the gateway.
4. Codex's final-sample steering race and `turn/start`-while-busy event identity need empirical evidence even though the pending-input source path is clear.
5. Codex `thread/inject_items` is explicitly model-visible, but ordering, durability, supported raw item variants, and interaction with active turns remain version-sensitive.
6. Pi does not carry RPC request IDs into events and does not define a durable queued-message identity, leaving reply correlation to a wrapper marker.
7. Pi queue survival across abort, compaction, session replacement, and process restart is unspecified.
8. OpenCode direct busy prompt can be persisted without a guaranteed assistant child. This must be treated as unsupported until a probe proves a narrower safe timing rule, not worked around by interpreting HTTP success.
9. OpenCode's first-party follow-up queue is app-local. Persistence and multi-client semantics are unknown.
10. Across all four harnesses, compaction can preserve a summary while losing exact nonce text. Conformance must distinguish semantic continuity from exact marker retention.
11. Across all four harnesses, authenticated sender identity is outside these model/session APIs. Any gateway origin must be wrapper-attested; native client IDs and origin enums are observability aids, not authority.

## Primary evidence

### Claude Code / Agent SDK

- **[C1]** Agent SDK 0.3.226 parity and current queue/origin changes: [CHANGELOG.md lines 1-24](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.226/CHANGELOG.md#L1-L24), [lines 39-78](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.226/CHANGELOG.md#L39-L78).
- **[C2]** Python wrapper pin used only as supplemental source: [claude-agent-sdk-python tag v0.2.134](https://github.com/anthropics/claude-agent-sdk-python/tree/v0.2.134).
- **[C3]** Current multi-turn and resume recommendation: [CHANGELOG.md lines 411-417](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.226/CHANGELOG.md#L411-L417).
- **[C4]** Bidirectional long-lived client documentation: [client.py lines 27-56](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.134/src/claude_agent_sdk/client.py#L27-L56).
- **[C5]** Command lifecycle, interrupt receipt, and queue cancellation: [CHANGELOG.md lines 119-132](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.226/CHANGELOG.md#L119-L132), [lines 39-43](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.226/CHANGELOG.md#L39-L43).
- **[C6]** Result origin and task-notification subkinds: [CHANGELOG.md lines 484-487](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.226/CHANGELOG.md#L484-L487), [lines 11-17](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.226/CHANGELOG.md#L11-L17), [lines 70-75](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.226/CHANGELOG.md#L70-L75).
- **[C7]** Session and hook history: [CHANGELOG.md lines 647-654](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.226/CHANGELOG.md#L647-L654), [lines 793-798](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.226/CHANGELOG.md#L793-L798).
- **[C8]** Resume point, fork, rewind, and SessionStart source: [CHANGELOG.md lines 19-28](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.226/CHANGELOG.md#L19-L28), [lines 214-219](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.226/CHANGELOG.md#L214-L219), [lines 720-724](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.226/CHANGELOG.md#L720-L724).
- **[C9]** Hook event and context-output types: [types.py lines 262-274](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.134/src/claude_agent_sdk/types.py#L262-L274), [lines 418-476](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.134/src/claude_agent_sdk/types.py#L418-L476).
- **[C10]** User frame writes and dynamic sends: [client.py lines 263-315](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.134/src/claude_agent_sdk/client.py#L263-L315).
- **[C11]** Interrupt control request: [query.py lines 768-787](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.134/src/claude_agent_sdk/_internal/query.py#L768-L787).
- **[C12]** Parsed receive loop and transcript-chain history: [client.py lines 275-285](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.134/src/claude_agent_sdk/client.py#L275-L285), [sessions.py lines 1039-1075](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.134/src/claude_agent_sdk/_internal/sessions.py#L1039-L1075).
- **[C13]** Turn result versus background-run lifetime: [query.py lines 911-947](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.134/src/claude_agent_sdk/_internal/query.py#L911-L947).

### Codex

- **[X1]** Workspace version: [codex-rs/Cargo.toml lines 134-138](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/Cargo.toml#L134-L138).
- **[X2]** App Server lifecycle: [app-server/README.md lines 76-87](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/app-server/README.md#L76-L87).
- **[X3]** Thread/history/input API contracts: [app-server/README.md lines 161-204](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/app-server/README.md#L161-L204).
- **[X4]** Steering example and preconditions: [app-server/README.md lines 1138-1155](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/app-server/README.md#L1138-L1155).
- **[X5]** Manual/automatic compaction lifecycle: [app-server/README.md lines 786-800](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/app-server/README.md#L786-L800), [lines 1547-1558](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/app-server/README.md#L1547-L1558).
- **[X6]** Turn/item lifecycle and correlation: [app-server/README.md lines 1517-1539](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/app-server/README.md#L1517-L1539).
- **[X7]** Structured request-user-input reply: [app-server/README.md lines 1642-1647](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/app-server/README.md#L1642-L1647).
- **[X8]** App Server steer validation and admission: [turn_processor.rs lines 910-1017](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/app-server/src/request_processors/turn_processor.rs#L910-L1017).
- **[X9]** Core active-turn checks and pending queue insertion: [session/mod.rs lines 3957-4037](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/session/mod.rs#L3957-L4037).
- **[X10]** Pending input to later provider request: [session/turn.rs lines 265-387](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/session/turn.rs#L265-L387), [hook_runtime.rs lines 532-595](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/hook_runtime.rs#L532-L595).
- **[X11]** `turn/start` submission versus synthetic response: [turn_processor.rs lines 557-607](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/app-server/src/request_processors/turn_processor.rs#L557-L607).
- **[X12]** Generic user input can steer or start: [session/handlers.rs lines 189-281](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/session/handlers.rs#L189-L281).
- **[X13]** Steer metadata and client ID type: [protocol/v2/turn.rs lines 170-204](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L170-L204).

### Pi

- **[P1]** Package pin: [packages/coding-agent/package.json lines 1-18](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/package.json#L1-L18).
- **[P2]** RPC prompt, steer, follow-up, abort, and acceptance semantics: [rpc.md lines 38-140](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/docs/rpc.md#L38-L140).
- **[P3]** Queue modes: [rpc.md lines 306-337](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/docs/rpc.md#L306-L337).
- **[P4]** SDK session/runtime controls: [sdk.md lines 70-180](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/docs/sdk.md#L70-L180), [lines 189-251](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/docs/sdk.md#L189-L251).
- **[P5]** RPC state and history: [rpc.md lines 161-215](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/docs/rpc.md#L161-L215).
- **[P6]** RPC lifecycle events and absent event IDs: [rpc.md lines 738-803](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/docs/rpc.md#L738-L803).
- **[P7]** Session tree and compacted context build: [session-format.md lines 285-326](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/docs/session-format.md#L285-L326).
- **[P8]** RPC implementation receipts: [rpc-mode.ts lines 370-415](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L370-L415).
- **[P9]** Session queue insertion: [agent-session.ts lines 1180-1246](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/agent-session.ts#L1180-L1246).
- **[P10]** Queue drain into model context: [agent-loop.ts lines 155-245](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/agent/src/agent-loop.ts#L155-L245).
- **[P11]** Low-level queue contract: [agent/types.ts lines 190-214](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/agent/src/types.ts#L190-L214).
- **[P12]** Extension user/custom message controls: [extensions.md lines 1268-1317](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/docs/extensions.md#L1268-L1317), [agent-session.ts lines 1263-1347](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/agent-session.ts#L1263-L1347).
- **[P13]** Input source type: [extensions/types.ts lines 744-759](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/extensions/types.ts#L744-L759).
- **[P14]** Custom message lowering drops custom metadata: [messages.ts lines 122-194](https://github.com/badlogic/pi-mono/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/messages.ts#L122-L194).

### OpenCode

- **[O1]** SDK and plugin package pins: [packages/sdk/js/package.json lines 1-20](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/sdk/js/package.json#L1-L20), [packages/plugin/package.json lines 1-27](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/plugin/package.json#L1-L27).
- **[O2]** Server session/message endpoints: [server.mdx lines 133-180](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/web/src/content/docs/server.mdx#L133-L180).
- **[O3]** SDK prompt and context-only `noReply`: [sdk.mdx lines 300-355](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/web/src/content/docs/sdk.mdx#L300-L355).
- **[O4]** TUI controls and SSE: [server.mdx lines 241-280](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/web/src/content/docs/server.mdx#L241-L280).
- **[O5]** Plugin lifecycle events: [plugins.mdx lines 137-207](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/web/src/content/docs/plugins.mdx#L137-L207).
- **[O6]** Plugin message/model transforms: [plugin/src/index.ts lines 222-296](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/plugin/src/index.ts#L222-L296).
- **[O7]** Compaction plugin controls: [plugin/src/index.ts lines 298-326](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/plugin/src/index.ts#L298-L326).
- **[O8]** User persistence and `noReply` branch: [session/prompt.ts lines 995-1071](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/opencode/src/session/prompt.ts#L995-L1071).
- **[O9]** Asynchronous prompt fork and error event: [handlers/session.ts lines 295-329](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts#L295-L329).
- **[O10]** Single-run join semantics: [effect/runner.ts lines 115-138](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/opencode/src/effect/runner.ts#L115-L138), [session/run-state.ts lines 52-107](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/opencode/src/session/run-state.ts#L52-L107).
- **[O11]** Loop reread, terminal exit, model lowering, and assistant parent: [session/prompt.ts lines 1081-1201](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/opencode/src/session/prompt.ts#L1081-L1201), [lines 1252-1339](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/opencode/src/session/prompt.ts#L1252-L1339).
- **[O12]** App-local follow-up queue and idle gate: [app submit.ts lines 430-487](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/app/src/components/prompt-input/submit.ts#L430-L487), [app session.tsx lines 1703-1758](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/app/src/pages/session.tsx#L1703-L1758), [lines 1928-1942](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/app/src/pages/session.tsx#L1928-L1942).
- **[O13]** TUI publication and ordinary prompt submission: [handlers/tui.ts lines 34-76](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/opencode/src/server/routes/instance/httpapi/handlers/tui.ts#L34-L76), [TUI prompt lines 237-248](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/tui/src/component/prompt/index.tsx#L237-L248), [lines 1092-1121](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/tui/src/component/prompt/index.tsx#L1092-L1121).
- **[O14]** User-message lowering includes content, not arbitrary metadata: [session/message-v2.ts lines 195-235](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/opencode/src/session/message-v2.ts#L195-L235).
- **[O15]** Compaction event and compacted-history projection: [session/compaction.ts lines 517-549](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/opencode/src/session/compaction.ts#L517-L549), [session/message-v2.ts lines 521-582](https://github.com/anomalyco/opencode/blob/d7b115f623760e68a4749d16508a9eca350f246f/packages/opencode/src/session/message-v2.ts#L521-L582).
