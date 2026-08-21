# Decisions

## 2026-08-20: 5-Level Hierarchy + baseRevision Schema

**Status:** accepted

**Context:** F1 required extending `harness/features/feature-list.json` from 4 to 5 levels (`Goal → Feature → Sprint → Task → Subtask`) while keeping `harness/` as SSOT and existing `dev-harness` CLI working. Needed `baseRevision` optimistic concurrency for atomic Pi tool writes, and per-task `key`, `dependsOn`, `subtasks`.

**Decision:** Add top-level `baseRevision: number`, `goals: {id,title,description}[]`, `sprints: {id,name,goalId}[]`; extend `feature.tasks[]` with `key: string`, `dependsOn: string[]`, `subtasks: {id,title,status}[]`. Validate against `harness/features/feature-list.schema.json` v1.0. Preserve `goals`/`sprints` in `fileFromHarnessState` round-trip. Keep `harness/` canonical; Pi session storage mirrors but never diverges.

**Consequences:** Single feature file stores full hierarchy; routing of `key = featureId/taskId` composite handles multi-feature future without migration. `baseRevision` increments only on real change; stale writes rejected. Existing `dev-harness` CLI still loads feature list (backward compatible due to `default`/`required` schema settings).

---

## 2026-08-21: Atomic `harness_task_list` with Omission Deletion and Compaction-Safe Replay

**Status:** accepted

**Context:** Pi compaction discards earlier `toolResult` content, causing widget state loss on long sessions and after `/tree` branch switches. Need one-call `harness_task_list({baseRevision, tasks})` where omission = deletion (99people/pi-todo pattern), with `dependsOn` cycle/missing and `in_progress`→deps `completed` guards, and visible widget survival without extra turn.

**Decision:** Adapt `@99percentpeople/pi-todo` atomic logic (MIT) re-pointed to `harness/features/feature-list.json`: `atomicApply` validates keys (1-40 alphanum `.` `_` `-`, composite `feature/task` with slash), normalizes statuses (`completed|done|closed|passed→complete`, `in_progress|in-progress→in_progress`), dedupes `dependsOn`, validates `subtasks`, runs `validateDeps` + `detectCycle`, prunes `completed→completed` edges to deleted completed tasks before missing check, and returns `{revision, tasks, change: {added,updated,removed,reordered}}`. Persist via temp-file+rename. Store `details: {rev, tasks}` on `harness_task_list` toolResult for branch replay, plus hidden `custom` entry `harness:checkpoint {rev,tasks}` via `pi.appendEntry` on `session_before_compact` / `session_compact`, re-injected via `context` event as `messages: [{role:"user", content:[{type:"text", text:"Harness checkpoint..."}]}]`. Periodic reminder every 3 LLM calls. Widget re-renders via `buildWidgetLinesFromState`; file helpers `harnessStateFromFile`/`fileFromHarnessState` preserve 5-level fields.

**Consequences:** Model must send full authoritative list each call (omission deletes); prevents partial stale merges. Compaction and `/tree` both replay from `toolResult.details` + `custom` without LLM awareness. Trade-off: requires discipline to include every key to retain; mitigated by periodic hidden reminder listing `rev + key/status`.

---

## 2026-08-21: Duplicate `src/` Logic in Extension for Runtime Isolation

**Status:** accepted

**Context:** `src/widget.ts` and `src/harnessTaskList.ts` contain pure logic needed both by tests and by the Pi extension at runtime. Extension runs inside Pi without a build/bundle step (type-checked via `tsc --noEmit` only). Importing `../../src/` from `extensions/harness-enforcer/index.ts` would create an implicit build dependency and risk Pi loader resolution failures for `string-width` etc.

**Decision:** Duplicate the essential helpers (widget rendering + atomic engine) inline in `extensions/harness-enforcer/index.ts` with comment noting origin and MIT provenance. Keep `src/` as authoritative tested source; extension copy marked as "inline adapted from src/... re-pointed". Record as debt to resolve via `tsup`/`esbuild` bundle once Pi package bundling is adopted.

**Consequences:** Two copies to maintain (review smell: **Duplicated Code**). Changed semantics must be updated in both places until bundling is added. Benefit: extension loads without extra build, tests remain isolated from Pi runtime, no regression risk from bundler config in F1. Lesson logged in `harness/lessons-decisions.md`.

---

| Date | Decision | Status |
|------|----------|--------|
| 2026-08-20 | 5-Level Hierarchy + baseRevision Schema | accepted |
| 2026-08-21 | Atomic harness_task_list with Omission Deletion + Compaction Replay | accepted |
| 2026-08-21 | Duplicate src Logic in Extension for Runtime Isolation | accepted |
