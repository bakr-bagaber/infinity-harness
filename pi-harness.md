# pi-harness

> **Status:** DEFINE — scaffolding new ops project
> **Goal:** Convert `dev-harness` CLI into a native Pi agent package where the harness loop is *enforced by Pi*, not by prompt-following.

## Why

Current `dev-harness` works, but only if the agent *chooses* to obey:

- Agent must manually run `dev-harness next` / `validate` / `phase next` — it can skip, hallucinate done, or stop mid-loop.
- No automatic session start — an agent cannot start a new Pi session by itself; the loop dies when the turn ends.
- Loops not enforced — `BUILD` task loop is a convention, not a runtime guard. Agent can exit early.
- Multi-agent broken — each sub-agent gets its own context, no shared harness state / locking.
- Continuous dev for days impossible — depends on the agent harness being driven externally. No daemon, no unattended loop.

Pi gives us the primitives to fix this: extensions can subscribe to `session_start`, `agent_start`, `turn_end`, `tool_call`, `session_shutdown`, register tools, store state via `pi.appendEntry()`, and drive the loop without the LLM deciding to.

## What This Project Produces

A **Pi package** `pi-harness` (successor to `dev-harness-pi` v5.1.0) that:

1. Installs via `pi install ./pi-harness` / `npm:pi-harness` / `git:...`
2. On `session_start` automatically injects the `dev-harness next` brief — no manual command needed.
3. On `turn_end` automatically runs `validate` and, on PASS, `phase next` — the loop is enforced.
4. Intercepts `tool_call` to block phase-skipping (`validate` is the only referee) and to prevent `harness/config.json` hand-edits.
5. Supports Pi sub-agents with shared harness state (file lock + `harness/` as single source of truth).
6. Enables unattended continuous development: `pi --loop` or extension-driven daemon that keeps running `next → work → validate` for days.
7. Reuses 100% of `dev-harness` CLI logic (`cli/lib/*`) — Pi is the *enforcement layer*, not a rewrite.

## Key References

- Source harness: `~/ops/Projects/dev-harness` (templates, `cli/lib/*`, `templates/harness-config.json`)
- Existing Pi package (v1 wrapper): `C:/Users/bakrb/ops/Projects/dev-harness-pi` (`extensions/index.ts` — just wraps CLI as `/harness:*` commands, no enforcement)
- Pi docs: `~/.pi/agent/docs` → `extensions.md`, `sessions.md`, `packages.md`, `skills.md`
- This spec: `SPEC.md` — requirements + success criteria
- Quick start: `README.md`

## Current State

- 2026-08-20: Project scaffolded. Next: DEFINE → read `dev-harness` + `pi` extension APIs, write `sprint-contract.md`, then PLAN.
