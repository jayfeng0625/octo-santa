# Workflow config

Backend-routed config for the workflow tracker (Issues / PRDs / Handoffs). The active backend is named by the `Backend:` token in the `## Agent skills` block; this file holds that backend's database IDs and property mappings. The glossary and ADRs are **not** here — they are fixed filesystem conventions (`CONTEXT.md` + `docs/adr/`).

## Backend

notion

## Workspace

ID: <workspace-id>

## Databases

Issues DB:    <id>
PRDs DB:      <id>
Handoffs DB:  <id>

## Issues DB properties

Status (status):
  needs-triage     → "needs-triage"
  needs-info       → "needs-info"
  ready-for-agent  → "ready-for-agent"
  ready-for-human  → "ready-for-human"
  wontfix          → "wontfix"

Category (select):
  bug              → "bug"
  enhancement      → "enhancement"

Blocked by: relation → Issues DB

## Handoffs DB properties

Epic (select): per-project workstream values; add options in Notion as new workstreams begin.

---

## DB seed schemas

These are the property definitions to pass to `mcp__notion__notion-create-database` when the user picks `create` for a missing DB in `/setup-bonai-skills`. The config sections above are what gets written to `workflow-config.md` (in the config dir) after IDs are known — this section is the *input* used to build the DBs in the first place.

### Issues DB

- **Name** (title) — required
- **Status** (status) — options: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`; default `needs-triage`
- **Category** (select) — options: `bug`, `enhancement`
- **Blocked by** (relation) — relates to Issues DB (self)

### PRDs DB

- **Name** (title) — required

### Handoffs DB

- **Name** (title) — required
- **Date** (date) — default today
- **Epic** (select) — per-project workstream values; seed empty (user adds options on first use) or with a placeholder option
