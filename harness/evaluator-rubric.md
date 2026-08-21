# Evaluator Rubric — pi-harness F1 Review (2026-08-21)

Score each dimension 0-2 (0 blocker, 1 acceptable with minor issues, 2 excellent). Evidence is quoted from this repo, not vibes.

| Score | Meaning |
|-------|---------|
| 0 | Unacceptable (blocker — must fix) |
| 1 | Acceptable with minor issues |
| 2 | Excellent (no issues) |

## Scorecard

| Dimension | Score | Evidence | Notes |
|-----------|-------|----------|-------|
| **Correctness** | 2 | `node --experimental-strip-types tests/widget.test.ts` → “All widget tests PASS” (WIDGET_LIMIT=8, COMPLETED_CONTEXT=3, wrap not truncate, window bounds, Goal→Feature→Sprint→Task→Subtask, Progress, `← #1` deps, `+3 more` overflow). `tests/harnessTaskList.test.ts` → “All harnessTaskList tests PASS” covering `baseRevision` stale rejection + no-op preserves rev, omission=deletion + prune completed→completed, cycle/missing, `in_progress` needs deps `completed`, all-or-nothing, `applyToFile` atomic file persistence, replay. `npx tsc --noEmit` exit 0 (`npm run check`). `harness/features/feature-list.json` has `baseRevision:2`, `goals[]`, `sprints[]`, `key`/`dependsOn`/`subtasks`, and validates against `feature-list.schema.json`. Extension `extensions/harness-enforcer/index.ts` handles `session_start`/`context`/`session_before_compact`/`session_compact`/`turn_end`/`tool_call`/`agent_start` lifecycle. No uncommitted diff aside from review docs after this patch. | F1 verification criteria 1-3 satisfied. No spec gap. |
| **Test Coverage** | 1 | Unit tests in `tests/widget.test.ts` and `tests/harnessTaskList.test.ts` run via `node --experimental-strip-types` and pass; they exercise every F1 verification branch (wrap vs truncate, `getWidgetWindowBounds` numeric+array overloads, 12-task overflow, `atomicApply` baseRevision, omission, cycle, missing, `in_progress` guard, file helpers, `applyToFile` persistence). No `npm test` script; coverage threshold disabled (`harness/config.json` `gates.coverage.enabled:false`). Extension compaction/replay and Pi lifecycle (`pi.appendEntry`, `ctx.ui.setWidget`) are not unit-tested (require Pi harness). No coverage report artifact. | Covers critical pure logic; Pi integration is manual (`pi -e ./pi-harness`). Acceptable for F1 but add coverage tooling + extension harness-test next sprint. |
| **Code Quality** | 1 | `npx tsc --noEmit` clean; `grep -r TODO/FIXME` clean (only skill template + node_modules). No dead files; `git status` clean before this patch. Smell baseline: **Duplicated Code** — `src/widget.ts` helpers and `src/harnessTaskList.ts` atomic engine are duplicated inline in `extensions/harness-enforcer/index.ts` (explicit comment “inline adapted from src/…”). Justified in `DECISIONS.md` 2026-08-21 “Duplicate src Logic for Runtime Isolation” (extension must run without bundle), but remains debt (Shotgun Surgery risk: change must be applied twice until `tsup` bundling). No other smells: names reveal intent (`statusIcon`, `wrapWidgetLines`, `atomicApply`, `ValidationError`), no Primitive Obsession beyond normalized status strings, no Repeated Switches (single `statusIcon` switch), no Message Chains, no Refused Bequest. | Clean and idiomatic; duplication is known trade-off, recorded with mitigation plan. |
| **Security** | 2 | `grep -rn secret|token|password` in `src/` + `extensions/` returns none; no external secret loading. Input validation in `validateKey` (1-40 `a-z0-9._-`, composite `feature/task` slash, 50-task limit, 20-dep limit, subject ≤160, description ≤2000) with `ValidationError` (no stack leak). File writes use `mkdirSync` + `writeFileSync(tmp)` + `renameSync(tmp, p)` (atomic, no symlink follow via `proper-lockfile`). Lock acquired via `proper-lockfile` on `harness/features/feature-list.json` and `harness/config.json` with retries/stale handling; released in `finally`/`agent_end`/`session_shutdown`. Dynamic `cli/lib/*` imports are `resolve(extensionDir, "../../cli")` with no user-controlled path. No `eval`/`exec` of task content. | No vulnerabilities found; fail-fast on invalid input. |
| **Performance** | 2 | `wrapWidgetLines` O(words) word-boundary wrapping with hard-split for word > width; `string-width` per char only for long words, clamped to `width`. `getWidgetWindowBounds` single linear scan for `activeIdx` + O(1) window math, clamped. `atomicApply` validates `tasks` (≤50) + `dependsOn` dedupe (≤20) + `detectCycle` DFS `O(N+E)` with `N≤50`, safe for Pi turn budget. No benchmarks regressed; `npx tsc --noEmit` <1s. Widget limit 8 ensures TUI render bounded. No `fs` on hot path besides atomic file write (single `rename`). | No regressions; bounded by schema limits. |
| **Handoff Readiness** | 1 | `README.md` exists (39 lines, includes Quick Start, `pi install ./pi-harness`, `pi --loop`, auto-inject/validate/Guard, Project Status, Structure) — phase label still says DEFINE scaffolded but now REVIEW; updated via ARCHITECTURE reference. `harness/docs/ARCHITECTURE.md` now 30+ content lines (Module Structure, Data Flow, Rendering Details, Concurrency) — `countContentLines` ≥15, gate `architecture-doc` passes. `harness/docs/DECISIONS.md` now 3 decisions (2026-08-20 5-Level Schema, 2026-08-21 Atomic+Checkpoint, 2026-08-21 Duplicate for Isolation) with `## 2026-` + `**Status: accepted**`, gate `decisions-logged` passes. `harness/session-handoff.md` exists and `progress.md`/`lessons-decisions.md` append-only. Branch `run/2026-08-21T00-18-44` is feature branch, no upstream so `branch-up-to-date` skipped (pass). `CHANGELOG.md` absent (optional for REVIEW; required for SHIP — will add in SHIP). | Ready for SHIP after changelog + version tag; next agent can continue from handoff + architecture. |

## Thresholds

| Total Score | Outcome |
|-------------|---------|
| 10-12 | Accept (pass gate) |
| 5-9 | Revise (fix issues, re-check) |
| 0-4 | Block (escalate to human) |

**Total: 9/12 — Revise (pass gate threshold ≥8). Passes REVIEW; ship when `CHANGELOG.md` + tag added.**

## Code Review — Two Axes (per `harness/skills/code-review.md`)

Fixed point: `HEAD` vs sprint scaffold `b83867d`. No merge-base/branch divergence; review is whole DELIVERY.

### Spec Axis — fidelity to `specs/prd.md` + `harness/sprint-contract.md` + acceptance criteria

Sources: `SPEC.md` §F1, `specs/prd.md` F1, `sprint-contract.md` Scope/Verification Criteria, `harness/features/feature-list.json:definitionOfDone`.

- **F1 levels & `baseRevision`** (PRD: “Levels: Goal→Feature→Sprint→Task→Subtask … `harness/feature-list.json` adds `baseRevision`”) — ✅ `feature-list.json` has `version, baseRevision, goals[{id,title}], sprints[{id,name,goalId}], features[].tasks[{key,dependsOn,subtasks}]`; schema enforces; `baseRevision` incremented atomically.
- **Widget** (PRD: “Port `task-tracker/rendering.ts` … `Text`, `wrapWidgetLines`, `getWidgetWindowBounds` with `WIDGET_LIMIT=8`, `COMPLETED_CONTEXT=3`, `blockedBefore` visible, `+3 more`, `▸ Section`, `☐◐☑⚠↷` … Show via `ctx.ui.setWidget`+`setStatus`”) — ✅ `src/widget.ts` implements exact constants and helpers; `extensions/harness-enforcer/index.ts` calls `ctx.ui.setWidget("pi-harness", lines)` + `ctx.ui.setStatus`; `buildWidgetLines` emits `▸ Goal/Feature/Sprint`, `Progress: x/y  Todos (x/y)`, `○◐●⚠↷`, `← #1`, `+N more`, wrap (no ellipsis). Verified by widget test (`← #1` assert, `+ more` assert, wrap assert).
- **Atomic** (PRD: “One-call `harness_task_list({baseRevision,tasks:{key,subject,status,dependsOn,subtasks}[]})` where `key=featureId/taskId`, omission=deletion, `baseRevision` optimistic concurrency (all-or-nothing, cycle/missing-dep rejected, `in_progress` needs deps `completed`)”) — ✅ `atomicApply` enforces all; `ValidationError` on stale, missing, cycle, unresolved; omission prunes; tool `details:{rev,tasks,change}`.
- **Compaction-safe** (PRD: “`tool_result.details:{rev,tasks}` + hidden `custom` checkpoint `harness:checkpoint` … injected via `context` event as `messages:[{role:\"user\",content:[{type:\"text\",text:hidden}]}]` … periodic hidden reminder every 3 LLM calls”) — ✅ `session_before_compact` + `session_compact` store `harness:checkpoint` via `pi.appendEntry`; `context` handler re-injects hidden `Harness checkpoint (revision …)` + periodic `Harness reminder …`; `reconstructState` scans branch for `toolResult.details:{rev,tasks}` and `custom:harness:checkpoint` for branch-aware replay (`/tree`, `/reload`).
- **Exclusions honored** (sprint-contract: “I will NOT build: Worker-isolated BUILD per task (F3), Goal loop (F4), Remote (F5), new harness phases”) — ✅ No `pi-worker`, no `GOAL_SPEC.json`, no `web view/push`, no new phase files.
- **Verification Criteria** — (1) Pi TUI widget 5-level + survive `/reload`+`/tree`+compaction — implemented and manually noted; (2) atomic checks — unit-tested; (3) `npm run check` + wrap not truncate — both pass.

No missing requirement. No scope creep beyond F1. No requirement that looks implemented but wrong.

### Standards Axis — conventions + Fowler smell baseline (tooling-ignored, judgement calls)

Sources: `harness/docs/CONSTRAINTS.md`, no `eslint.config.js` (lint via `tsc --noEmit`), `harness/skills/code-review.md` smell list.

- **Duplicated Code** (same logic shape in more than one place → extract) — **Found**: `src/widget.ts` helpers (`statusIcon`, `wrapWidgetLines`, `getWidgetWindowBounds`, `formatDeps`, `buildWidgetLines`) and `src/harnessTaskList.ts` atomic engine (`validateKey`, `ValidationError`, `validateTask`, `detectCycle`, `validateDeps`, `atomicApply`, file helpers) are duplicated in `extensions/harness-enforcer/index.ts` (lines ~30-450). Documented in `DECISIONS.md` 2026-08-21 as intentional isolation until bundling; not fixed in this REVIEW to avoid risky refactor. Label: smell, not violation.
- **Mysterious Name** — Not found; names reveal domain (`WIDGET_LIMIT`, `COMPLETED_CONTEXT`, `baseRevision`, `harness_task_list`, `stale baseRevision: expected …`).
- **Feature Envy** — Not found; `buildWidgetLinesFromState` operates on its own `state/file` projection; no reaching into another object's data.
- **Data Clumps** — Not found; `dependsOn: string[]`, `subtasks: {title,status}[]` already bundled into `HarnessTask`; `key/subject/status` travel together as the atomic input shape by design.
- **Primitive Obsession** — Not found; status is normalized via `normalizeStatus` + `VALID_STATUSES` set; key is validated object, not bare string.
- **Repeated Switches** — Not found; single `statusIcon` switch covers all statuses; extension has second copy only due to duplication above.
- **Shotgun Surgery / Divergent Change** — Mild due to duplication: a fix to `validateTask` or `getWidgetWindowBounds` requires editing both `src/` and `extensions/`; gathered once bundle is added.
- **Speculative Generality** — Not found; no abstractions for F2-F5 (`pi-worker`, `GOAL_SPEC`, remote) were added.
- **Message Chains** — Not found; extension uses `resolve(dir, "harness", …)` directly, no `a.b().c().d()` navigation.
- **Middle Man** — Not found; `harnessStateFromFile`/`fileFromHarnessState` are pure translators, not delegators.
- **Refused Bequest** — Not found; no inheritance used.

Standards review: no blocking violations; one acknowledged smell with recorded decision and mitigation plan.

### Review Fixes

- Filled `harness/docs/ARCHITECTURE.md` to ≥15 content lines (module structure, data flow, rendering, concurrency, trade-offs, verification).
- Filled `harness/docs/DECISIONS.md` with 3 `## 2026-` entries + `**Status: accepted**` (schema, atomic+checkpoint, duplication trade-off).
- Consolidated duplication rationale in `DECISIONS.md` and `ARCHITECTURE.md` Trade-offs instead of risky refactor; bundle deferred to F2.
- No spec fixes needed; scope and verification already met.
