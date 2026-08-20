# SPEC — pi-harness

## Goal

Convert `dev-harness` from an **external CLI that agents must remember to call** into a **native Pi agent package** where the harness pipeline is **enforced by Pi runtime**, enabling reliable, autonomous, multi-agent, continuous development.

## Problem Statement

`dev-harness` today is agent-agnostic and works via `dev-harness next` / `validate` / `phase next`. In practice, when pointed at by Claude Code, Codex, Hermes, etc., the process is **not automatic**:

1.  **Not automatic** — Agent reads `AGENTS.md` / `harness/docs/phases/*.md` but must *choose* to run `next`. No runtime injects it.
2.  **Cannot start a new session** — When a task completes, the agent cannot call `pi -c` or `/new` by itself; the loop terminates and waits for human to start next turn.
3.  **Loops not enforced** — `BUILD` task loop, retry loops, `gateHistory` — all are conventions. Agent can claim `validate` PASS without running it, or skip `phase next`.
4.  **Multi-agent broken** — Pi sub-agents (or multiple Pi instances) share nothing; two agents can `phase next` concurrently and corrupt `harness/config.json`. No locking, no `session-handoff.md` coordination.
5.  **No continuous development** — Cannot run for days unattended. Depends on human driving the loop turn-by-turn. No daemon, no `pi --loop`, no `session_shutdown` → `session_start` chaining.

And more: `progress.md` / `lessons-decisions.md` are append-only but not enforced, `harness/` file edits are not guarded, `clean-state-checklist.md` not run, etc.

## Solution: Pi Package as Enforcement Layer

**Do not rewrite `dev-harness` logic.** Reuse `cli/lib/*` (brief, gates, state, phases, validate, etc.) as a library. The Pi package is a *thin enforcement shell* around it.

### Architecture

```
pi-harness (Pi package)
├── extensions/
│   └── harness-enforcer/
│       └── index.ts          # <-- THE CORE: subscribes to Pi lifecycle
├── skills/                   # Re-export 29 craft skills (tdd, code-review, etc.)
├── prompts/                  # Re-export prompts (AGENTS.md, docs/phases/*.md)
├── templates/                # Re-export templates (harness-config.json, etc.)
└── package.json  { pi: { extensions: [...], skills: [...], prompts: [...] } }
```

### Extension: harness-enforcer

Single extension that enforces the loop:

| Pi Event | Handler | Enforces |
|---|---|---|
| `session_start` | `ctx.ui.notify` + inject `dev-harness next` brief into context | **Automatic** — no manual `/harness:next` needed. On every new session (including resumed), the brief is injected. |
| `turn_end` | Run `gates.validate()` (import from `cli/lib/gates.mjs`), if PASS then `phases.next()` | **Loop** — agent cannot exit loop by stopping. Extension drives `next → work → validate → phase next` until `SHIP` or `PAUSED`. |
| `tool_call` (before) | Intercept `harness/config.json` writes, `git` phase skips, `dev-harness phase next` without `validate` PASS | **Guard** — `validate` is the only referee. Block hand-edits, require gate PASS. |
| `agent_start` / `agent_end` (sub-agents) | Acquire file lock on `harness/config.json` + `harness/session-handoff.md` | **Multi-agent** — shared state, no corruption. |
| `session_shutdown` | Write `session-handoff.md`, decide to auto-resume (`pi --loop` or `ctx.requestResume()`) | **Continuous** — chaining sessions for days. |
| `command: /harness:*` | Keep existing 20+ commands for manual override, but mark as *escape hatch* not primary loop | Compatibility |

### Key Design Decisions

- **Reuse, don't rewrite:** `cli/lib/brief.mjs`, `gates.mjs`, `state.mjs`, `phases.mjs`, `validate-schema.mjs` are imported directly. No duplication.
- **File as source of truth:** `harness/` remains single source of truth. Pi session storage (`pi.appendEntry`) mirrors it, but `harness/config.json` is canonical.
- **Locking:** `proper-lockfile` or `flock` on `harness/config.json` for multi-agent. Pi sub-agents block until lock acquired.
- **Unattended loop:** Extension can call `ctx.requestTurn()` or use Pi's loop mode to keep driving. Human can `Ctrl+C` to pause (`dev-harness pause`).
- **Backwards compatible:** Existing `dev-harness` CLI still works. Pi package is additive. `dev-harness-pi` v1 users can upgrade to `pi-harness` without changing `harness/` structure.

## Success Criteria

### Must (MVP)

1.  `pi install ./pi-harness` succeeds, appears in `pi list`
2.  Opening `pi` in a project with `harness/` auto-injects `next` brief on `session_start` (verified via session transcript, no manual `/harness:next`)
3.  After agent completes a task, `turn_end` auto-runs `validate`; on PASS, auto-runs `phase next` and injects next brief — agent never types `validate` or `phase next`
4.  Attempt to hand-edit `harness/config.json` `currentPhase` without `validate` PASS is **blocked** via `tool_call` interceptor (returns `block: true`)
5.  Two concurrent sub-agents cannot corrupt `harness/config.json` (lock test: parallel `phase next` → one succeeds, one waits)
6.  `pi --loop` (or extension auto-resume) runs at least 3 full `BUILD` tasks unattended without human input, with `progress.md` and `gateHistory` correctly updated
7.  All 29 craft skills still load (`/skills` shows `tdd`, `code-review`, etc.)
8.  Existing `dev-harness` CLI still works when Pi package not installed (no breaking change to `cli/`)

### Should

- Session handoff survives `pi -c` (continue) and `/resume` — next brief is still auto-injected
- `clean-state-checklist.md` auto-checked on `session_start`
- Works with `harness/capability/index.json` (capability acquisition still works)

### Non-Goals (this sprint)

- New harness phases or gates — reuse existing `define → plan → build → verify → review → ship`
- Rewriting `dev-harness` in Rust/Go — keep Node.js `cli/lib/*`
- Pi TUI custom components — use `ctx.ui.notify` / `confirm` only for MVP

## Constraints

- Node.js ≥18, Pi ≥ current, `dev-harness` v5.1.0 as peer
- Must work on WSL Ubuntu-24.04 (primary dev) and Windows (via `wsl.exe` wrapping where needed — see `harness/lessons-decisions.md` lessons on `stackMeta`)
- No new dependencies beyond `ajv`, `picocolors`, `simple-git` (already in `dev-harness-pi`); add `proper-lockfile` only if needed for locking
- Keep `dev-harness-pi` v1 installable side-by-side for comparison; new package is `pi-harness` (name TBD: `dev-harness-pi-v2` or `pi-harness`)

## References

- `dev-harness` source: `~/ops/Projects/dev-harness`
- Current Pi wrapper: `C:/Users/bakrb/ops/Projects/dev-harness-pi`
- Pi extension API: `extensions.md`, `sessions.md`, `packages.md`
- Lessons: `~/ops/Projects/AutoExtract/harness/lessons-decisions.md` (stackMeta, gate timeouts, WSL wrappers)
