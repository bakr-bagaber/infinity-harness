# PRD — pi-harness v1.0

## Vision

`pi-harness` is the Pi-native, gate-enforced, visually trackable harness. It is the superset of `dev-harness` + every Pi todo/task package, surviving restarts, compaction, and branch switches, with 5-level hierarchy and worker isolation.

## v1.0 Goal

Ship `pi-harness` `1.0.0` (from current `5.1.0` dev-harness base) as a Pi package that is **visually trackable at 5 levels**, **atomically revisioned**, and **compaction-safe** — the foundation for F2-F5 (workers, goal loop, remote).

## F1 — Visual 5-Level Widget + baseRevision (this sprint)

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

**Out of Scope for F1:** Worker isolation per BUILD task (F3), Goal loop `GOAL_SPEC.json` (F4), Remote web view (F5) — those are F2-F5.

## Verification Criteria (F1)

1. `pi -e ./pi-harness` shows live widget in Pi TUI: `Goal → Feature → Sprint → Task → Subtask` with `○●◐⚠↷`, `Progress: 1/5`, `+2 more` when >8, `← #1` deps, survives `/reload` + `session_before_compact` (hidden checkpoint) + `/tree` (branch-aware replay from `toolResult.details` + `custom`).
2. `harness/features/feature-list.json` has `baseRevision`, `tasks` have `key`, `dependsOn`, `subtasks`; `harness_task_list` with stale `baseRevision` is rejected; omission deletes; `in_progress` with uncompleted dep is rejected; `dependsOn` cycle is rejected (unit tests).
3. `npm test` passes and `npx tsc --noEmit` passes; widget renders without truncation (wrap, not ellipsis) for long labels.

## Non-Goals

* No `pi-worker` per task yet (F3)
* No `GOAL_SPEC.json` generation yet (F4)
* No `/remote` yet (F5)
