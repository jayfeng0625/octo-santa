# Messaging Patterns for Agents

Quick reference for reading strategies when using octo-santa's messaging tools.

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
