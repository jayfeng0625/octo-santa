---
name: setup-bonai-skills
description: Scaffolds an `## Agent skills` block in AGENTS.md/CLAUDE.md plus the `commands.md` and `workflow-config.md` files (written into a config dir chosen at setup, default `docs/agents/`) that bonai-dev engineering skills read for per-language test/lint/build commands and per-repo workflow database IDs. Interactive — asks for the config dir, the tracker backend, language commands, and DB IDs. Use when the user says "setup bonai", "initialize bonai skills", "configure agent skills", "set up this repo for the engineering skills", or before first use of `tdd`, `diagnose`, `grill-with-docs`, `prototype`, `triage`, `to-issues`, `to-prd`, `improve-codebase-architecture`, or `handoff` in a new repo.
disable-model-invocation: true
---

# Setup Bonai Skills

Scaffold the per-repo configuration that the engineering skills assume:

- **Config dir** — the directory that holds the two relocatable config files (`commands.md` + `workflow-config.md`). Chosen once at setup (default `docs/agents/`) and recorded in the `## Agent skills` block as a single `Config dir:` value; skills resolve both files through the block.
- **Commands** — the canonical shell commands for running tests, linting, type-checking, and building this repo. Skills never name a test runner directly; they read these.
- **Workflow backend** — the tracker backend (`Backend:` token, e.g. `notion`) plus the 3 workflow database IDs (Issues, PRDs, Handoffs) and the property → canonical-role mappings so skills can use abstract verbs. The glossary and ADRs are **not** part of this config — they are fixed filesystem conventions (`CONTEXT.md` + `docs/adr/`).

This is a prompt-driven skill, not a deterministic script. Explore, present what you found, confirm with the user, then write.

## Process

### 1. Explore

Look at the current repo to understand its starting state. Read whatever exists; don't assume:

- `AGENTS.md` and `CLAUDE.md` at the repo root — does either exist? Is there already an `## Agent skills` section? If so, read its `Config dir:` value — that is where prior config lives.
- The config dir (default `docs/agents/`, or whatever an existing block names) — does this skill's prior output already exist? If `commands.md` or `workflow-config.md` is present, treat it as the user's authoritative version and offer to edit it rather than overwriting.
- Project manifest files for inference hints only: `package.json`, `pyproject.toml`, `Cargo.toml`, `build.gradle(.kts)`, `Makefile`. Surface candidate commands from `scripts` blocks, but the user's answer is authoritative — never silently detect.

### 2. Pick the config directory

Ask one question: where to write the per-repo agent config. Default `docs/agents/`. The chosen directory holds **both** `commands.md` and `workflow-config.md` and is recorded **once** in the block as a single `Config dir:` value — filenames are conventions within it, not separate path fields. If an `## Agent skills` block already names a `Config dir:`, offer that as the default.

> Where should I write the per-repo agent config (`commands.md` + `workflow-config.md`)? Default `docs/agents/`. You can point this at any path, including a gitignored one.

### 3. Walk the user through Commands

Use `AskUserQuestion` to ask about each of the four canonical commands in sequence. For each, present any inferred candidates as the first option labelled "(Inferred from <file>)".

For each command, ask one question. Example for `test_command`:

> What command runs the test suite for this repo? Skills like `/tdd` and `/diagnose` will use this verbatim — it should be the single command that runs all tests from a clean shell.

Repeat for `lint_command`, `typecheck_command`, `build_command`. If any of the four doesn't apply (e.g. a TS-only repo with no separate build step), accept "n/a" — skills will skip that command when it's blank.

### 4. Walk the user through the workflow backend

Notion is the default backend in Stage 1; the interactive flow below is Notion-specific. If the user does not use Notion, point them at the reference recipes in [../tracker-primitives/gh.md](../tracker-primitives/gh.md) or [../tracker-primitives/local.md](../tracker-primitives/local.md) and let them hand-author `workflow-config.md` in the config dir from those files — the engineering tile still works, just without the interactive setup for that backend.

Only the **3 workflow DBs** (Issues, PRDs, Handoffs) are configured here. The domain glossary and ADRs are fixed filesystem conventions (`CONTEXT.md` + `docs/adr/`) — they are **not** Notion DBs and are never prompted for.

For Notion users, ask in sequence:

1. **Workspace ID.** "Paste the workspace ID for the Notion workspace you'll use for this repo."
2. **The 3 database IDs.** One question per DB: Issues DB, PRDs DB, Handoffs DB. For each, ask: "Paste the database ID, or say 'create' and I will create it from a seed schema." If the user says 'create', call `mcp__notion__notion-create-database` against the workspace using the matching DB's property schema from the **`## DB seed schemas`** section of [`workflow-config.template.md`](./workflow-config.template.md). If the create call fails (no MCP write permission, auth error), stop and tell the user — they need to grant Notion MCP write access or create the DB manually and re-run, in which case prompt for the ID instead.
3. **Property mappings for the Issues DB.** Ask the user to confirm or override the canonical Status mappings: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. Default: each role's string equals its name. Ask the user to confirm or override the Category mappings: `bug`, `enhancement`. Default: each maps to its own name. Ask whether the DB has a `Blocked by` relation property; if so, capture its exact name.
4. **Property mappings for the Handoffs DB.** The Handoffs DB has an `Epic` select property — used by `/handoff` to subdivide handoffs by workstream within this project. If the DB was just created from the seed schema, the option list is empty; tell the user they will add Epic options on first use of `/handoff`. If the DB already exists, capture the property name (default `Epic`) so `/handoff` can match it.

### 5. Confirm and write

Show the user a draft of:

- The `## Agent skills` block to add to whichever of `CLAUDE.md` / `AGENTS.md` is being edited (see step 6 for selection rules). The block records the chosen config dir once as a single `Config dir:` value, carries the `Backend:` token in the Workflow-backend entry, and includes a **Domain language** entry pointing read-only consumers (`/tdd`, `/diagnose`) directly at `CONTEXT.md` + `docs/adr/`.
- The contents of `commands.md` (use [`commands.template.md`](./commands.template.md) as the seed)
- The contents of `workflow-config.md` (use [`workflow-config.template.md`](./workflow-config.template.md) as the seed)

Let them edit before writing.

### 6. Write

**Pick the file to edit:**

- If `CLAUDE.md` exists, edit it.
- Else if `AGENTS.md` exists, edit it.
- If neither exists, ask the user which one to create — don't pick for them.

Never create `AGENTS.md` when `CLAUDE.md` already exists (or vice versa) — always edit the one already there.

If an `## Agent skills` block already exists, update its contents in-place rather than appending a duplicate. Don't overwrite user edits to the surrounding sections.

The block (substitute the chosen config dir for `<config-dir>` and the chosen backend for `<backend>`):

```markdown
## Agent skills

**Config dir:** `<config-dir>` — holds the relocatable config below (`commands.md` + `workflow-config.md`).

### Commands

Repo-wide commands for testing, linting, type-checking, and building. See `commands.md` in the Config dir.

### Workflow backend

**Backend:** <backend> — selects the `tracker-primitives/<backend>.md` recipe. The Issues / PRDs / Handoffs database IDs and property mappings live in `workflow-config.md` in the Config dir.

### Domain language

Glossary: `CONTEXT.md` (repo root). ADRs: `docs/adr/` (repo root). Read these files **directly** — they are fixed filesystem conventions, not block-resolved and not under the Config dir. Skills that only read (e.g. `/tdd`, `/diagnose`) ground from them and degrade gracefully when absent.
```

The `Config dir:` value is the single place the relocatable config location is recorded — never repeat it per file. The `Backend:` token is what a skill reads to load `tracker-primitives/<backend>.md`. The Domain-language entry is the same for every backend — glossary and ADRs are always filesystem conventions, never Notion DBs.

Then write `commands.md` and `workflow-config.md` into the chosen config dir using the templates in this skill folder.

### 7. Done

Tell the user the setup is complete and which engineering skills will now read from these files. Mention they can edit the files in the config dir directly later — re-running this skill is only necessary to switch backends, move the config dir, or restart from scratch.
