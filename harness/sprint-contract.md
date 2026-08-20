# Sprint Contract — pi-harness F1

## Scope (Generator proposes)

**I will build:**
F1 Visual 5-Level Widget + baseRevision (see `specs/prd.md` F1). Extend `harness/features/feature-list.json` to 5 levels (`Goal→Feature→Sprint→Task→Subtask`) with `baseRevision`, `key`, `dependsOn`, `subtasks`. Add `src/widget.ts` ported from `task-tracker/rendering.ts` + `pi-long-task` sidebar + `rpiv`/`99people` display. Add `extensions/harness-enforcer` widget via `ctx.ui.setWidget`/`setStatus` + `harness_task_list` tool (one-call, omission=deletion, `baseRevision` check) + hidden `harness:checkpoint` custom for compaction, injected via `context` event. Keep `harness/` as SSOT, `tcs --noEmit` clean.

**I will NOT build:**
Worker-isolated BUILD per task (F3), Goal loop `GOAL_SPEC.json`/reviewer (F4), Remote web view/push (F5), new harness phases/gates — keep `define→ship` and `gates.runChecks()`.

## Verification Criteria (Generator proposes)

1. Pi TUI shows `Goal → Feature → Sprint → Task → Subtask` widget with `○●◐⚠↷`, `Progress: x/y`, `+3 more` overflow, `← #1` deps, survives `/reload`, `/tree`, and compaction (hidden checkpoint).
2. `baseRevision` optimistic concurrency, omission deletion, `dependsOn` cycle/missing and `in_progress` needs deps `completed` are enforced (tests).
3. `npm test` + `npx tsc --noEmit` pass; long labels wrap not truncate.

## Evaluator Review (Evaluator fills in)

- [x] Scope is clear and bounded: yes — only widget + 5-level + atomic + compaction-safe, F2-F5 explicitly excluded.
- [x] Verification criteria are sufficient: yes — visual + atomic + types are all testable.
- [x] Exclusions are reasonable: yes — workers/goal/remote are separate features.

Agreed.

## Agreement Status

**Status:** Agreed
**Negotiation rounds:** 1/5
