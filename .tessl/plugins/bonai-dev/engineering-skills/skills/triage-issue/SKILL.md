---
name: triage-issue
description: Investigates a reported bug by exploring the codebase to find root cause, then creates an issue in the configured tracker with a TDD-based fix plan. Use when user reports a bug, wants to file an issue, mentions "triage", or wants to investigate and plan a fix for a problem.
---

# Triage Issue

Investigate a reported problem, find its root cause, and create an issue with a TDD fix plan. Minimise questions to the user — start investigating immediately.

## Verbs used

- `create issue page` — to write the issue to the Issues DB
- `transition state` — to move the issue to `ready-for-agent` after creation (the TDD plan is complete; no additional triage needed)

Backend-specific MCP / CLI mappings live in `../tracker-primitives/<backend>.md`.

## Process

### 1. Capture the problem

Get a brief description from the user. If they haven't provided one, ask ONE question: "What's the problem you're seeing?" Do NOT ask follow-ups. Start investigating immediately.

### 2. Explore and diagnose

Use the Agent tool with subagent_type=Explore to deeply investigate the codebase. Find:

- **Where** the bug manifests (entry points, UI, API responses)
- **What** code path is involved (trace the flow)
- **Why** it fails (the root cause, not just the symptom)
- **What** related code exists (similar patterns, tests, adjacent modules)

Look at: related source files and their dependencies, existing tests (what's tested, what's missing), recent changes to affected files (`git log`), error handling in the code path, similar patterns elsewhere that work correctly.

### 3. Identify the fix approach

Determine: the minimal change needed to fix the root cause, which modules/interfaces are affected, what behaviors need test coverage, and whether this is a regression, missing feature, or design flaw.

### 4. Design TDD fix plan

Create a concrete, ordered list of RED-GREEN cycles. Each cycle is one vertical slice:

- **RED**: Describe a specific test that captures the broken/missing behavior
- **GREEN**: Describe the minimal code change to make that test pass

Rules: tests verify behavior through public interfaces (not internals); one test at a time, vertical slices only; each test survives internal refactors; include a final refactor step if needed. Describe behaviors and contracts, not internal structure — a good suggestion reads like a spec, not a diff.

### 5. Create the issue

Invoke `create issue page` (Issues DB) with the body rendered from the template below. Then invoke `transition state` to move it to `ready-for-agent` — the TDD plan is complete and ready to implement.

After creating the issue, share the issue URL and a one-line summary of the root cause.

<issue-template>

## Problem

- What happens (actual behavior)
- What should happen (expected behavior)
- How to reproduce (if applicable)

## Root Cause Analysis

Describe what you found: the code path involved, why the current code fails, any contributing factors. Do NOT include specific file paths, line numbers, or implementation details that couple to current code layout — describe modules, behaviors, and contracts instead.

## TDD Fix Plan

A numbered list of RED-GREEN cycles:

1. **RED**: Write a test that [describes expected behavior]
   **GREEN**: [Minimal change to make it pass]

2. **RED**: Write a test that [describes next behavior]
   **GREEN**: [Minimal change to make it pass]

**REFACTOR**: [Any cleanup needed after all tests pass]

## Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] All new tests pass
- [ ] Existing tests still pass

</issue-template>
