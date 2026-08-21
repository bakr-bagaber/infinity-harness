# PRD — pi-harness v1.0

## Vision

`pi-harness` is the Pi-native, gate-enforced, visually trackable harness. It is the superset of `dev-harness` + every Pi todo/task package, surviving restarts, compaction, and branch switches, with 5-level hierarchy and worker isolation.

## v1.0 Goal

Ship `pi-harness` `1.0.0` (from current `5.1.0` dev-harness base) as a Pi package that is **visually trackable at 5 levels**, **atomically revisioned**, and **compaction-safe** — the foundation for F2-F5 (workers, goal loop, remote).

## F1 — Visual 5-Level Widget + baseRevision (shipped v0.2.0)

**Levels:** `Goal → Feature → Sprint → Task → Subtask` (from 4 to 5).

* **Goal** (optional, for `pi_goal_task` style): `harness/goals/goal-*.md` + `harness/goals/GOAL_SPEC.json`
* **Feature** (existing): `harness/features/feature-list.json:features[]`
* **Sprint** (new explicit): `harness/sprints/sprint-*.json` (was implicit via `features-archive/`)
* **Task** (existing): `feature.tasks[]` with `key`, `dependsOn: string[]`, `baseRevision`
* **Subtask** (new): `task.subtasks: {title, status: pending|in_progress|done}[]` (from `pi-long-task` `**Status:**` checkboxes)

**Widget:** Port `task-tracker/rendering.ts` (`Text`, `wrapWidgetLines`, `getWidgetWindowBounds` with `WIDGET_LIMIT=8`, `COMPLETED_CONTEXT=3`, `blockedBefore` visible, `+3 more`, `▸ Section`, `☐◐☑⚠↷`) + `pi-long-task` sidebar (right TUI overlay when wide, `Progress: 2/5`, `Worker spend`) + `rpiv-todo` heading `Todos (2/7)` + `99people` `← #1` dep numbers. Show via `ctx.ui.setWidget("pi-harness", {render})` + `ctx.ui.setStatus` + collapse `Ctrl+Shift+T` (rpiv).

**Atomic + Compaction-Safe:**
* One-call `harness_task_list({baseRevision, tasks: {key, subject, status, dependsOn, subtasks}[]})` where `key = featureId/taskId`, omission = deletion (99people), `baseRevision` optimistic concurrency (all-or-nothing, cycle/missing-dep rejected, `in_progress` needs deps `completed`).
* `harness/feature-list.json` adds `baseRevision: number` (incremented on each successful write).
* `tool_result.details: {rev, tasks}` + hidden `custom` checkpoint `harness:checkpoint` with `{rev, tasks}` after compaction, injected via `context` event as `messages: [{role:"user", content:[{type:"text", text: hidden}]}]` (99people), so model sees exact keys after compaction without extra turn. Periodic hidden reminder every 3 LLM calls with `rev + key/status` list.

## F2 — Enforcer Auto-Loop Hardening (shipped v0.3.0)

Harden `extensions/harness-enforcer/index.ts` from F1 notify-only to full auto-loop without stream race: `session_start` lightweight `notify`+`widget`, `context` hidden checkpoint and periodic reminder every 3 calls, `session_before_compact` `appendEntry` checkpoint, `tool_call` guard blocks phase-skip without `PASS`, `turn_end` notify-only (no `sendUserMessage` mid-stream), `high` not `xhigh` for `dev-harness run` workers. Untacked harness runtime state to fix BUILD `git-clean`.

## F3 — Worker Isolation per BUILD Task (this sprint, v0.4.0)

**Problem:** `BUILD` tasks currently run in the main agent context. A faulty task can pollute the main session (dirty `harness/config.json` `gateHistory`, leaked env, half-written `feature-list.json`), and parallel `dev-harness run` workers can corrupt shared state. The dummy harness at `/tmp/pi-harness-dummy` already proved a fresh `pi --print` (`pi -p`) per task with attempt history works.

**Solution:** Fresh isolated worker per BUILD task.

* New module `src/worker.ts` (pure, tested): `createWorkerRunDir`, `spawnIsolatedWorker`, `recordAttempt`, attempt history to `tmp/pi-harness/<run-id>/<featureId>/<taskId>/attempt-N/{prompt.md, output.log, fingerprint.json}`. Uses `proper-lockfile` on `harness/features/feature-list.json` and `harness/config.json` so concurrent workers do not corrupt `baseRevision`. Preserves 5-level fields through file helpers.
* Integration point 1 — `extensions/harness-enforcer/index.ts`: expose `harness_spawn_worker` hidden helper (or just reuse `src/worker.ts` logic) so Pi can request an isolated run without touching main context. The extension itself stays notify-only; the worker is invoked by `dev-harness run` or manually via `pi --print` loop.
* Integration point 2 — `harness/config.json` `run.agents.pi.cmd` remains `pi --provider opencode --model opencode/muse-spark-1.2-contributor-free --thinking high -p "$(cat {promptfile})"` but the run driver now writes per-task `tmp/pi-harness/<run-id>/` directories and passes `{promptfile}` isolated per attempt. Existing `dev-harness run` loop in `dev-harness/cli/lib` already isolates via `git checkout -b run/<id>`; F3 adds filesystem isolation and attempt history.
* No new harness phase; reuse `define → plan → build → verify → review → ship`. No `GOAL_SPEC.json` yet (F4), no remote yet (F5).

## Verification Criteria (F3)

1. `npx tsc --noEmit` passes; `src/worker.ts` exists with worker-dir + isolation helpers, unit tests in `tests/worker.test.ts` passing (create dir, record attempt, lock, baseRevision preserved, fingerprint).
2. Fresh `pi --print` per BUILD task is demonstrated: a worker run writes `tmp/pi-harness/<run-id>/<feature>/<task>/attempt-1/` with `prompt.md` + `output.log` + `fingerprint.json`, does not dirty main `harness/config.json` `gateHistory` beyond expected, and survives `proper-lockfile` concurrent test.
3. `package.json` version bumps to `0.4.0` and `CHANGELOG.md` has `## [0.4.0]` entry describing worker isolation; `pi-harness` enforcer still loads (`extensions/harness-enforcer/index.ts` `tsc` clean, no `sendUserMessage` mid-stream regression).

## Non-Goals (this sprint)

* No `GOAL_SPEC.json` generation yet (F4)
* No `/remote` yet (F5)
* No `pi --loop` daemon beyond per-task isolation (continuous loop stays in enforcer `turn_end`+`session_before_compact`)

## Out of Scope for F1/F2 (done)

Worker isolation per BUILD task (F3), Goal loop `GOAL_SPEC.json` (F4), Remote web view (F5) — those are F3-F5.

## Verification Criteria (F1 — historical)

1. `pi -e ./pi-harness` shows live widget in Pi TUI: `Goal → Feature → Sprint → Task → Subtask` with `○●◐⚠↷`, `Progress: 1/5`, `+2 more` when >8, `← #1` deps, survives `/reload` + `session_before_compact` (hidden checkpoint) + `/tree` (branch-aware replay from `toolResult.details` + `custom`).
2. `harness/features/feature-list.json` has `baseRevision`, `tasks` have `key`, `dependsOn`, `subtasks`; `harness_task_list` with stale `baseRevision` is rejected; omission deletes; `in_progress` with uncompleted dep is rejected; `dependsOn` cycle is rejected (unit tests).
3. `npm test` passes and `npx tsc --noEmit` passes; widget renders without truncation (wrap, not ellipsis) for long labels.

## Non-Goals (F1)

* No `pi-worker` per task yet (F3)
* No `GOAL_SPEC.json` generation yet (F4)
* No `/remote` yet (F5)
