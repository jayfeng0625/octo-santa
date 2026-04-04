# Messaging Patterns for Agents

Communication strategies for agents using octo-santa's messaging tools.

> **Using the REPL?** These patterns are for programmatic agents. The REPL handles polling automatically — you just see messages as they arrive. See [repl.md](repl.md) for the REPL reference.

---

## Agent Lifecycle

Every agent session follows this sequence:

```
1. messaging_register        — claim a unique name, bind to this process
2. messaging_create_channel   — create channels as needed
3. messaging_subscribe        — subscribe to channels for push notifications
4. Send / read messages       — communicate with other agents
5. (disconnect)               — automatic cleanup, PID cleared
```

Read-only tools (`messaging_list_channels`, `messaging_list_agents`, `messaging_list_members`) work without registration.

---

## Notification Contract

### DM channels (push-all)

Created via `messaging_direct_message`. Both parties get push notifications for every message — no `@mention` required. DM channels have a deterministic name format (`agentA,agentB`, sorted alphabetically).

Use DMs when you need guaranteed delivery to a specific agent.

### Regular channels (mention-only)

Created via `messaging_create_channel`. Only messages containing `@agent-name` or `@all` trigger push notifications. Unmentioned messages are silent — recipients see them only when they actively call `messaging_read_messages`.

### Mention syntax

- `@agent-name` — notify a specific agent
- `@all` — notify all channel subscribers
- No mention — message is silent (context/logging)

---

## Communication Patterns

### Cross-Domain Query

Discover an expert and DM them:

```
Agent A: brain_find_expert()
  → { identifier: "payments-api", active_agents: ["be-impl"] }
Agent A: messaging_direct_message("fe-impl", "be-impl", "How do webhooks retry?")
  → Agent B gets push notification (DM mode)
Agent B: brain_read("webhook-schemas")
Agent B: (replies in DM channel with answer)
```

### Coordination Channel

A shared channel where agents post status updates and coordinate work. Use `@mentions` to get specific agents' attention:

```
messaging_send_message("planner", "project-alpha", "@all Phase 1 complete. @implementer you're up.")
```

### Multi-Agent Task Delegation

A coordinator dispatches work to specialized agents:

```
messaging_send_message("planner", "impl-channel", "@frontend Build the login page")
messaging_send_message("planner", "impl-channel", "@backend Set up the auth endpoints")
```

Each agent gets notified only for messages that mention them.

---

## The Two Read Modes

| Call | Advances cursor? | Purpose |
|------|-----------------|---------|
| `messaging_read_messages(agent_id, channel)` | **Yes** | Drain unread queue |
| `messaging_read_messages(agent_id, channel, before_id=N)` | **No** | Scroll history for context |

The cursor tracks what you've "consumed". Forward mode advances it; history mode never does.

---

## Strategy 1 — Cursor Drain

**When:** You've been idle and want to catch up on everything you missed.

```
messaging_read_messages(agent_id="me", channel="chat", limit=200)
```

Returns all messages since your last read in one call, then advances your cursor.
Bump `limit` if you expect a large backlog (default is 100).

**Why it's efficient:** All missed messages arrive in one tool result rather than one
turn per push notification. 40 missed messages = 1 tool call, not 40 interrupts.

---

## Strategy 2 — Pre-Task Check-In

**When:** You're about to do work and want to ensure you have current channel state.

```
1. messaging_list_channels()                        # see what's active
2. messaging_read_messages(agent_id="me", channel=X) # drain each relevant channel
3. proceed with task
```

Pair with a system prompt instruction like:
> "Before starting any task, drain your cursor on relevant channels."

**Why it's efficient:** You only pay for catch-up when you're already awake for
another reason — no idle polling cost.

---

## Strategy 3 — Context Window (before_id)

**When:** You were just @mentioned and need to understand the conversation that
preceded the message — your cursor drain showed you the unread messages but you
need the backstory.

```
# Step 1: drain unread — get messages [id: 80..100]
messaging_read_messages(agent_id="me", channel="chat")

# Step 2: get context before the oldest unread
messaging_read_messages(agent_id="me", channel="chat", before_id=80, limit=20)
```

To scroll further back, paginate:
```
before_id=80, limit=20   → messages 60–79
before_id=60, limit=20   → messages 40–59
```

**Why it doesn't advance your cursor:** `before_id` mode is purely a read window.
You're looking at history without "consuming" anything — your unread queue is unchanged.

---

## Strategy 4 — Lazy Catch-Up On @Mention (recommended default)

**When:** You're a passive participant in a channel and only need to engage when
explicitly brought in. Do nothing until @mentioned, then reconstruct.

```
On receiving a channel notification:
1. messaging_read_messages(agent_id="me", channel="chat")
   → drain all unread since your last read

2. If the context is unclear, get the preceding discussion:
   messaging_read_messages(agent_id="me", channel="chat",
                           before_id=<first_unread_id>, limit=30)

3. Now respond with full context
```

**Why it's the cheapest overall:** Zero tokens spent while passive. You only pay
for catch-up at the moment you're actually needed, and `before_id` lets you
reconstruct context without re-consuming the unread queue.

---

## Strategy 5 — Scheduled Polling

**When:** You need near-real-time awareness of a channel even for messages that
don't @mention you (e.g. you're a monitor or logger agent).

```
/loop 60s messaging_read_messages(agent_id="me", channel="chat")
```

**Why it costs more:** Each poll creates a full agent turn, even when the result
is `[]`. At 60s intervals over a long session, empty polls dominate the cost.
Only use this if you genuinely need to react to unmentioned messages.

---

## Decision Guide

```
You need to...                              → Use
──────────────────────────────────────────────────────────────
Catch up before doing work                 → Strategy 2 (pre-task check-in)
Catch up after being idle                  → Strategy 1 (cursor drain)
Understand context when @mentioned         → Strategy 4 (lazy + before_id backfill)
Read history without affecting your cursor → Strategy 3 (before_id window)
Monitor all messages, not just @mentions   → Strategy 5 (polling — accept the cost)
```

---

## Coordinator Discipline: @Mention Hygiene

When a coordinator agent orchestrates multiple worker agents, **@mentions are implicit
action signals**. Agents primed to execute will treat visibility of a problem + a
possible solution as an invitation to act — even without an explicit instruction.

### Rules for Coordinators

1. **Only @mention agents who need to act or respond.** Use targeted mentions
   (`@agent-name`) instead of `@all` for discussions that don't require everyone's
   input. Broadcasting awareness of options to agents who aren't part of the
   decision risks premature action.

2. **Scope decision discussions to decision-makers.** If you're weighing options
   with one agent (e.g., a backend specialist), don't broadcast the options to
   implementation agents who might jump on one before a decision is made.

3. **When @all is necessary, explicitly gate action.** If you must broadcast
   context to all agents, include a clear hold: *"This is for awareness only —
   do NOT act until I confirm a decision."*

4. **Separate information from instruction.** An agent receiving a message that
   describes a problem and a fix within their scope will often execute the fix.
   If that's not the intent, say so explicitly.

### Rules for Worker Agents

1. **Do not act on channel discussions unless explicitly instructed by the
   coordinator.** Seeing a problem described and a possible fix is not the same
   as being asked to implement it.

2. **When in doubt, ask.** If a channel message seems like it might require
   action from you, confirm with the coordinator before proceeding.

### Why This Matters

Agents are biased toward action. A coordinator broadcasting `@all Here are two
options: A (backend fix) or B (frontend fix)` will often trigger the frontend
agent to implement Option B immediately — before the coordinator has decided.
The revert costs time and pollutes git history.

```
BAD:   @all We could do Option A or Option B     → agent acts on B
GOOD:  @backend-agent We could do Option A or B   → only backend sees it
GOOD:  @all Awareness only, do NOT act: ...       → agents wait
```
