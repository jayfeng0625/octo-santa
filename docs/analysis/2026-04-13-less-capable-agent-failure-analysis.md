# Less Capable Agent Failure Analysis

**Date:** 2026-04-13
**Context:** Testing Gemma4:26b via opencode harness with two agents (os-pm, os-tl) collaborating through octo-santa messaging.

---

## Observable Failure Modes

### 1. Excessive reasoning about tool mechanics
Both agents spend enormous amounts of their thinking budget figuring out HOW to call tools, rather than WHAT to accomplish. os-pm's thinking about "periodically check" is 90% about whether it CAN loop, not about the business goal.

### 2. No autonomous reaction to incoming messages
When os-pm receives a message, nothing happens until the human explicitly says "perform action based on the message, then respond." The agent doesn't recognize that receiving a channel notification should trigger action.

### 3. Confusion about async/background capabilities
os-pm spirals into whether it can run bash loops, write python scripts, use curl, spawn subagents — all to solve "periodically check." It doesn't know its own capabilities or boundaries.

### 4. Shallow message comprehension
os-tl receives messages and summarizes them as "No new messages have arrived since my last check" without actually engaging with the content or deciding on next actions.

### 5. Over-serialized execution
Both agents think step-by-step through trivial tool calls (register then subscribe) when they could be parallel.

### 6. No proactive behavior
Neither agent initiates. They wait for explicit human instructions for every micro-step.

---

## Root Causes

### Root Cause 1: Absent mental model of self
The agent doesn't know what it IS. It doesn't know it's a messaging participant with a role. It treats each tool call as an isolated API request rather than understanding "I am os-pm, a product manager, participating in an async conversation." Claude/Codex internalizes identity from system prompts; weaker models treat system prompts as reference text, not identity.

### Root Cause 2: No event-action mapping
There's no guidance that says "when you receive a message addressed to you, you MUST read it and respond." The agent treats message receipt as informational, not as a trigger. Capable models infer this from context; weaker models need explicit event→action rules.

### Root Cause 3: Tool selection paralysis from too many options
The thinking traces show the agent considering bash, python, curl, subagents, todo tools — it's overwhelmed by optionality. A capable model prunes irrelevant tools instantly; a weaker model enumerates all possibilities linearly.

### Root Cause 4: No workflow state machine
The agent has no concept of "I am in state X, the valid next actions are Y." Each turn starts from scratch. There's no persistent sense of "I sent a message, now I should wait for a reply, and when it comes, I should act on it."

### Root Cause 5: Instruction following vs. goal pursuing
These agents are instruction-followers, not goal-pursuers. They do exactly what they're told, nothing more. "Check messages" → they check. But they don't reason "I checked, there's a new message asking me something, therefore I should respond."

---

## Gap Analysis: What Octo-Santa Provides vs What Agents Need

### What octo-santa provides today:
- Tool descriptions (register, subscribe, send, read, etc.)
- MCP server instructions (brief — "call messaging_register before sending", "use @mentions to get attention")
- Channel notification tags when messages arrive

### What's MISSING for less capable agents:

1. **Role playbook** — No document says "You are a PM. When you receive a message, here's your decision framework." The role is just a name.

2. **Tool selection guide** — No document says "For messaging tasks, use ONLY these 5 tools. Ignore bash, ignore subagents, ignore todo." The agent wastes cycles considering irrelevant tools.

3. **Event-reaction rules** — No document says "When you see `<channel source='octo-santa'>`, IMMEDIATELY read the channel and formulate a response." The notification is just data, not a trigger.

4. **Workflow templates** — No document says "The messaging workflow is: register → subscribe → send/read loop. Here are examples of each step." The agent has to infer the workflow from tool descriptions.

5. **Response format guidance** — No document says "When responding to a message, quote the relevant part, state your position, and ask a clear follow-up question." The agents produce vague summaries instead of substantive replies.

6. **Capability boundaries** — No document says "You CANNOT run background loops. You CAN be polled by the harness. Don't try to solve async monitoring yourself." The agent wastes time on impossible approaches.

---

## Specific Fix Mapping

| Failure | Fix Needed |
|---------|-----------|
| os-pm spirals on "periodically check" | Clear capability boundary statement: "You cannot run background tasks. To monitor a channel, the human or harness will prompt you to check. When prompted, call read_messages and act on what you find." |
| os-pm doesn't act on received messages | Event-reaction rule: "After reading messages, if any message is addressed to you, you MUST: (1) understand the request, (2) formulate a substantive response, (3) send your response back to the channel. Never just summarize — always act." |
| os-tl sends a bare directive without context | Message quality template: "When sending a message, include: (1) what you're asking, (2) relevant context or constraints, (3) what kind of response you need." |
| Both agents treat each turn as isolated | State tracking: "Before each action, review your recent message history in the channel to understand the conversation state." |
| os-pm considers bash, python, curl for messaging | Tool scoping: "For channel communication, use ONLY: messaging_register, messaging_subscribe, messaging_send_message, messaging_read_messages. Do NOT use bash, file operations, or other tools for messaging tasks." |

---

## Core Insight

**The gap isn't in the tools — the tools work fine. The gap is in the GUIDANCE LAYER between the tools and the agent's decision-making.** Capable models generate this layer internally; weaker models need it externally.

---

## Solution Framework: "Scaffolding for Less Capable Agents"

Three intervention points, ordered by impact and feasibility:

### 1. Enhanced MCP Instructions (High impact, Easy)
Expand server instructions with:
- Explicit event→action rules
- Tool scoping per task type
- Capability boundary statements
- Message quality templates

### 2. Brain-Stored Playbooks (High impact, Medium)
Create brain documents for:
- Role-specific behavior guides
- Workflow state machines with transition rules
- Few-shot example libraries
- Troubleshooting / "when stuck" guides

### 3. Harness-Level Integration Patterns (Medium impact, Hard)
Provide reference implementations for:
- Polling loops with automatic read-and-react
- System prompt templates per role
- Event handler patterns
- State persistence between turns

---

## Architectural Consideration: Two-Tier Guidance

**Tier 1 (MCP instructions):** Essential event-reaction rules, tool scoping, capability boundaries. Always in context. ~500 words. This is the minimum viable fix — improves ALL agents regardless of harness.

**Tier 2 (Brain documents):** Role playbooks, workflow templates, few-shot examples. Pulled on demand. Unlimited length. Opt-in — capable models ignore them, weaker models pull them.

The key insight for tier placement: a weak model won't know to ask for help (it doesn't know what it doesn't know). So the MINIMUM guidance must be in the MCP instructions themselves. The brain is for EXTENDED guidance.
