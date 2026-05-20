# Approach 1 Permutation Evaluation Report

**Date:** 2026-04-13
**Approach:** Profile `instructions` field (free-text) + MCP instruction refresh
**Method:** Replay transcript scenarios and edge cases against Approach 1, evaluating whether the design resolves each failure

---

## Design Under Evaluation

**Layer A (MCP Instructions):** Universal floor. Enhanced with event→action rules, tool scoping, capability boundaries. Delivered to every agent at connection time. ~500 words. Must stay under 2KB (Claude Code truncation limit).

**Layer C (Profile Instructions):** Role-specific behavioral guidance. Free-text field in profile YAML. Delivered in the `messaging_register` response. Agent/harness responsible for keeping it in context.

---

## Scenario Replays

### Scenario 1: os-pm told to "periodically check latest message"

**Original failure:** Agent spirals for 3+ minutes considering bash loops, python scripts, curl, subagents, todo tools. Never arrives at a simple `read_messages` call.

**With Approach 1:**

| Layer | Guidance injected | Expected effect |
|-------|-------------------|-----------------|
| A (MCP instructions) | "You CANNOT run background tasks or polling loops. When asked to monitor a channel, call `messaging_read_messages`. Your harness or the human will prompt you again later." | Eliminates the spiral. Agent sees a clear boundary and a clear action. |
| C (Profile instructions) | "When checking channels, read messages and act on any addressed to you. Summarize only if nothing requires action." | Adds role-specific framing on top. |

**Verdict: RESOLVED.** The capability boundary statement in Layer A directly addresses the root cause. Even a 7B model can follow "do X, don't try Y."

**Residual risk:** The agent might still not know HOW OFTEN to check. Layer A can't solve this — it's a harness concern (polling interval). Noted for harness integration follow-up.

---

### Scenario 2: os-pm receives a message but doesn't act until human says "perform action"

**Original failure:** Agent reads the message, summarizes it as "The latest message is from os-tl and addresses a draft...", then stops. Doesn't recognize it should respond.

**With Approach 1:**

| Layer | Guidance injected | Expected effect |
|-------|-------------------|-----------------|
| A (MCP instructions) | "After calling `messaging_read_messages`, if any message is addressed to you (@your-name or @all), you MUST: (1) understand what is being asked, (2) decide on a response, (3) call `messaging_send_message` to reply. Never just summarize — always act." | Direct event→action rule. The word MUST + numbered steps gives weak models a clear procedure. |
| C (Profile instructions) | "As a PM, when you receive a proposal or draft, evaluate it against project priorities and provide a clear decision or feedback with reasoning." | Adds role-specific decision framework. |

**Verdict: LIKELY RESOLVED.** The event→action rule is explicit enough for 20-30B models. For 7-13B models, there's a risk they still summarize first and "forget" to act — the numbered steps help but aren't guaranteed.

**Residual risk:** Very weak models may interpret "understand what is being asked" as a terminal action (they "understood" it, done). Mitigation: the numbered list makes step 3 (send_message) explicit and hard to skip.

---

### Scenario 3: os-tl sends a bare directive "@os-pm decide what the next roadmap items to tackle"

**Original failure:** Message lacks context, constraints, or expected response format. Even a capable receiver would struggle to give a good answer.

**With Approach 1:**

| Layer | Guidance injected | Expected effect |
|-------|-------------------|-----------------|
| A (MCP instructions) | "When sending a message, include: (1) what you're asking or proposing, (2) relevant context, (3) what kind of response you need. Poor example: 'decide the roadmap.' Good example: '@os-pm We need to pick the next 2 roadmap items. Candidates: A, B, C. Constraints: team bandwidth is 1 dev for 2 weeks. Which should we prioritize and why?'" | Few-shot example teaches message quality. |
| C (Profile instructions for os-tl) | "As a tech lead, when requesting decisions from the PM, always include: the options you've identified, technical constraints, and your recommendation." | Role-specific message template. |

**Verdict: PARTIALLY RESOLVED.** The few-shot example in Layer A helps significantly — weak models excel at pattern matching. However, the agent must actually READ and INTERNALIZE the MCP instructions when composing a message. If it's already in "just send it" mode, it may skip the guidance.

**Residual risk:** MCP instructions are delivered at connection time. By the time the agent is composing a message (possibly many turns later), the instructions may be out of active context for smaller context-window models. This is a fundamental limitation of one-time delivery.

---

### Scenario 4: os-tl monitors channel and reports "No new messages" despite messages existing

**Original failure:** Agent calls `read_messages` twice in quick succession, gets results the first time, then reports "no new messages" because the second call returns empty (messages already marked read).

**With Approach 1:**

| Layer | Guidance injected | Expected effect |
|-------|-------------------|-----------------|
| A (MCP instructions) | "When you call `messaging_read_messages`, messages are marked as read. You will NOT see them again on the next call. If the first call returned messages, act on them — do not call read again expecting to see the same messages." | Explains read-once semantics. |

**Verdict: RESOLVED.** This is a tool semantics issue. Clear documentation in Layer A prevents the double-read mistake.

---

## Edge Cases

### Edge Case 1: Agent registers without a profile (no Layer C)

**Scenario:** An agent connects with `messaging_register("random-bot")` — no profile YAML exists.

**With Approach 1:** Agent gets Layer A (MCP instructions) only. No profile instructions.

**Assessment:** This is the baseline. Layer A must be self-sufficient for agents without profiles. The event→action rules, tool scoping, and capability boundaries all apply universally. The agent won't have role-specific guidance but can still participate effectively in messaging.

**Verdict: ACCEPTABLE.** Layer A alone is a significant improvement over the current state. Profile instructions are additive, not required.

---

### Edge Case 2: Profile instructions contradict MCP instructions

**Scenario:** MCP instructions say "always respond to messages addressed to you." Profile instructions say "only respond to messages tagged #urgent."

**With Approach 1:** No explicit precedence rule. The agent sees both instructions and must reconcile.

**Assessment:** For capable models, this is fine — they'll recognize the profile as a refinement of the general rule. For weak models, contradictions cause unpredictable behavior (they may follow whichever instruction they processed last).

**Mitigation:** Add a precedence statement to Layer A: "Profile instructions refine but do not override these base rules. If your profile instructions seem to conflict with these rules, the profile instructions take precedence for role-specific behavior."

**Verdict: NEEDS DESIGN DECISION.** The precedence rule should be part of the spec.

---

### Edge Case 3: Profile instructions are too long for agent context

**Scenario:** A profile has 2000 words of detailed instructions. The agent is running on a model with 4K-8K context window. The instructions consume a significant portion of available context.

**With Approach 1:** Instructions are delivered in the registration response as a text field. It's up to the harness to decide how much to keep in context.

**Assessment:** This is a harness-level concern, not a framework concern. However, we should provide guidance: "Keep profile instructions under 500 words. For detailed role playbooks, use brain documents and reference them from profile instructions."

**Mitigation:** Add a recommended length guideline to the profile YAML schema docs. Optionally: warn at profile load time if instructions exceed a threshold.

**Verdict: ACCEPTABLE with guideline.** Document the recommendation; don't enforce it in code.

---

### Edge Case 4: Multiple agents with the same profile (pool scenario)

**Scenario:** Three `os-dev` instances register (os-dev-1, os-dev-2, os-dev-3). All get the same profile instructions.

**With Approach 1:** All pool members get identical instructions from the profile. No instance-specific differentiation.

**Assessment:** This is correct behavior. Pool members SHOULD have the same behavioral baseline. If differentiation is needed (e.g., "os-dev-1 handles frontend, os-dev-2 handles backend"), that's coordination — handled via channel messages, not profile instructions.

**Verdict: CORRECT BY DESIGN.** Pool-wide consistency is the right default.

---

### Edge Case 5: Agent receives a message but is not the intended recipient

**Scenario:** Agent os-dev-1 reads channel messages and sees a message addressed to `@os-pm`. The event→action rule says "if any message is addressed to you, act on it."

**With Approach 1:** Layer A says "addressed to you (@your-name or @all)." The agent should recognize that `@os-pm` is not `@os-dev-1` and skip it.

**Assessment:** Capable models handle this. Weak models might interpret "addressed to you" loosely and respond to every message they read.

**Mitigation:** Make the rule more explicit: "addressed to you means the message contains @your-registered-name or @all or @your-pool-name. Messages mentioning other agents are not addressed to you — do not respond to them unless you have relevant information to contribute."

**Verdict: NEEDS REFINEMENT.** The event→action rule needs tighter scoping on "addressed to you."

---

### Edge Case 6: Harness doesn't support injecting registration response into context

**Scenario:** A minimal harness (basic MCP client) calls `messaging_register` and gets back the profile instructions in the response, but doesn't have a mechanism to persist that text in the agent's system prompt or ongoing context. It just shows the tool result once.

**With Approach 1:** Instructions are delivered but may be lost after the first turn in some harnesses.

**Assessment:** This is a real concern for minimal harnesses. Claude Code and opencode both keep tool results in conversation history, so the instructions persist until context compaction. But a bare MCP client might not.

**Mitigation options:**
1. Document that harnesses SHOULD persist registration response instructions
2. Also include a condensed version of instructions in the MCP server instructions (Layer A) as a fallback
3. Provide a `messaging_get_instructions` tool that agents can call later to re-read their profile instructions

**Verdict: NEEDS MITIGATION.** Option 3 (re-readable instructions) is the most robust. Consider adding it to the spec.

---

### Edge Case 7: MCP instruction token budget (2KB Claude Code limit)

**Scenario:** Claude Code truncates server instructions at 2KB. Our enhanced MCP instructions need to fit within this budget while covering event→action rules, tool scoping, capability boundaries, and message quality templates.

**With Approach 1:** Current MCP instructions are ~1.5KB. Adding event→action rules and few-shot examples could push past 2KB.

**Assessment:** This is a hard constraint for Claude Code. Other harnesses (opencode, Pi) may not have this limit, but we should design for the lowest common denominator.

**Mitigation:**
1. Prioritize ruthlessly — event→action rules and capability boundaries are highest impact per token
2. Move few-shot examples to profile instructions or brain docs
3. Use terse, imperative language (not prose)
4. Test the actual byte count before finalizing

**Verdict: HARD CONSTRAINT.** Must budget the MCP instruction content carefully. Few-shot examples may not fit in Layer A.

---

### Edge Case 8: Agent on a model that doesn't support tool calling natively

**Scenario:** Some very small models (7B) have unreliable tool calling — they hallucinate tool names, miss required parameters, or format JSON incorrectly.

**With Approach 1:** The guidance assumes the agent can reliably call tools. If it can't, no amount of behavioral instructions helps.

**Assessment:** This is out of scope for octo-santa. Tool calling reliability is a model + harness problem. The harness is responsible for tool call formatting and error recovery.

**Verdict: OUT OF SCOPE.** Document that the guidance assumes basic tool calling works. Harness integration patterns (follow-up task) should address tool calling reliability.

---

### Edge Case 9: Cross-harness instruction format compatibility

**Scenario:** Different harnesses expect instructions in different formats:
- **Claude Code:** MCP server instructions as text, tool descriptions in JSON schema. Truncates at 2KB. Supports `instructions` field on MCP server config.
- **opencode:** Skills as SKILL.md files with YAML frontmatter. Searches `.opencode/skills/`, `.claude/skills/`, `.agents/skills/`.
- **Pi:** Loads AGENTS.md from project and parent dirs. Supports SYSTEM.md per-project. Extensions can inject messages before each turn.
- **Codex:** Plugins with bundled skills. MCP servers configured in plugin manifests.

**With Approach 1:** Profile instructions are delivered via MCP tool response (registration). MCP server instructions are universal. Both are harness-agnostic — they travel through the MCP protocol, which all harnesses implement.

**Assessment:** This is actually the strongest argument FOR Approach 1. MCP is the universal transport. By delivering guidance through MCP tool responses and server instructions, we avoid harness-specific integration entirely. The guidance arrives through the same channel regardless of whether the agent runs on Claude Code, opencode, Pi, or Codex.

**Residual concern:** Each harness handles MCP server instructions differently:
- Claude Code: shows them in `<system-reminder>` tags, truncates at 2KB
- opencode: surfaces as part of tool context (exact mechanism varies)
- Pi: MCP tool results are in conversation history, extensions can filter
- Codex: MCP server instructions surface as tool context

**Verdict: STRONG ADVANTAGE.** MCP-level delivery is the right abstraction. Harness-specific formatting is a display concern, not a content concern.

---

### Edge Case 10: Instructions reference tools that don't exist in the agent's environment

**Scenario:** Profile instructions say "use brain_read to find the coordinator playbook." But the octo-santa instance doesn't have brain configured (no `brain` key in config.json). The `brain_read` tool doesn't exist.

**With Approach 1:** Instructions are static text in YAML. They don't know which tools are actually available.

**Assessment:** For capable models, they'd try `brain_read`, get an error, and adapt. For weak models, a tool that doesn't exist causes confusion or hallucinated tool calls.

**Mitigation:**
1. Profile instructions should only reference tools that are guaranteed to exist (all messaging tools exist if octo-santa is running)
2. Add a guideline: "Profile instructions SHOULD only reference messaging_* tools. References to brain_* tools should be conditional: 'If brain is available, ...'"
3. Alternatively: the registration response could include a list of available tool categories

**Verdict: MINOR RISK.** Add a documentation guideline. Not worth adding code complexity.

---

## Cross-Harness Compatibility Matrix

| Harness | Layer A (MCP Instructions) | Layer C (Profile Instructions) | Notes |
|---------|---------------------------|-------------------------------|-------|
| **Claude Code** | Delivered as `<system-reminder>`. 2KB limit. Always in context. | Delivered in `messaging_register` tool result. Persists in conversation history until compaction. | Best support. Both layers work well. Few-shot examples may not fit in Layer A due to 2KB limit. |
| **opencode** | Surfaced as tool context. No documented size limit. | Delivered in `messaging_register` tool result. Persists in conversation. | Works. Skills system could complement with harness-side playbooks, but not required. |
| **Pi** | MCP tool context. Extensions can filter/augment. | Delivered in tool result. Extensions can re-inject if needed. | Works. Pi's extension system could persist profile instructions across compaction if desired. |
| **Codex** | MCP server instructions in plugin context. | Delivered in tool result. | Works. Codex plugins could add complementary skills, but MCP delivery is sufficient. |
| **Bare MCP client** | Server instructions at connection time. | Delivered in tool result. May be lost after first turn. | Minimal support. Consider `messaging_get_instructions` tool as fallback. |

---

## Failure Mode Summary

| # | Scenario | Resolved? | Residual Risk | Mitigation Needed? |
|---|----------|-----------|---------------|---------------------|
| S1 | Polling spiral | YES | Harness polling config | No (harness concern) |
| S2 | No action on messages | LIKELY YES | Very weak models may still stop at "understand" | Refine numbered steps |
| S3 | Bare directive messages | PARTIAL | Instructions may be out of context by send time | Few-shot in Layer A helps |
| S4 | Double-read confusion | YES | None | No |
| E1 | No profile (Layer A only) | ACCEPTABLE | Less guidance but functional | No |
| E2 | Contradicting instructions | NEEDS DECISION | Weak models confused by contradictions | Add precedence rule |
| E3 | Instructions too long | ACCEPTABLE | Context pressure on small models | Add length guideline |
| E4 | Pool same instructions | CORRECT | None | No |
| E5 | Wrong recipient | NEEDS REFINEMENT | Weak models respond to all messages | Tighten "addressed to you" |
| E6 | Harness doesn't persist | NEEDS MITIGATION | Instructions lost after first turn | Add re-readable tool |
| E7 | 2KB token budget | HARD CONSTRAINT | Few-shot examples may not fit | Budget carefully, move examples to Layer C |
| E8 | Bad tool calling | OUT OF SCOPE | Model/harness problem | Document assumption |
| E9 | Cross-harness compat | STRONG | MCP is universal transport | None needed |
| E10 | Missing tools referenced | MINOR | Weak models confused | Documentation guideline |

---

## Recommendations for Spec

Based on this evaluation, Approach 1 should include:

1. **Precedence rule** in Layer A: profile instructions refine but layer A is the behavioral floor
2. **Tight "addressed to you" definition** in the event→action rule
3. **`messaging_get_instructions` tool** for re-reading profile instructions (mitigates harness persistence issues)
4. **Length guideline** for profile instructions (recommend ≤500 words)
5. **2KB budget plan** for Layer A content — prioritize event→action rules and capability boundaries; move few-shot examples to Layer C
6. **Tool reference guideline** — profile instructions should only reference guaranteed-available tools
7. **One concrete playbook** (os-pm) as validation artifact
