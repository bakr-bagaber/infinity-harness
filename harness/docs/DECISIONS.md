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

## 2026-08-21: F2 Enforcer Auto-Loop Hardening

**Status:** accepted

**Context:** F1 extension used `notify`+`widget` but required manual `validate`/`phase next` and had stream race if `turn_end` sent a message mid-stream. Need Pi lifecycle auto-loop without blocking the model stream, plus periodic hidden checkpoint reminder and config edit guard.

**Decision:** Harden `extensions/harness-enforcer/index.ts` to session_start lightweight notify+widget, context hidden checkpoint replay (toolResult.details+custom) with periodic reminder every 3 LLM calls, session_before_compact appendEntry checkpoint, tool_call guard blocking hand-edits to `harness/config.json` without PASS, turn_end notify-only (no sendUserMessage mid-stream), and downgrade dev-harness run workers from xhigh to high thinking. Untrack harness runtime state to fix BUILD git-clean.

**Consequences:** Loop is now automatic and compaction-safe with no stream race. Guard prevents phase skipping. Workers use cheaper thinking tier.

---

## 2026-08-21: F3 Worker Isolation per BUILD Task

**Status:** accepted

**Context:** BUILD tasks ran in main session, risking dirty gateHistory and concurrent file corruption. Needed per-task attempt history and file locks reusing the dummy pi-harness pattern with fresh `pi --print`.

**Decision:** Add `src/worker.ts` with `createWorkerRunDir`, `spawnIsolatedWorker`, `recordAttempt`, `buildFingerprint`, `hashLite` using `proper-lockfile` on `harness/features/feature-list.json` and `harness/config.json`. Attempt history to `tmp/pi-harness/<run-id>/<featureId>/<taskId>/attempt-N/{prompt.md,output.log,fingerprint.json}`. Expose hidden tool `harness_spawn_worker` delegating to worker.ts. Ignore `tmp/pi-harness/` in git. Extension stays notify+appendEntry only.

**Consequences:** Each BUILD task gets isolated dir and lock; concurrent workers no longer corrupt baseRevision. History enables unstuck fingerprinting.

---

## 2026-08-22: F4 Goal Loop with GOAL_SPEC.json + Reviewer Worker

**Status:** accepted

**Context:** Needed natural-language goal → persisted spec → iteration loop until reviewer agrees done, porting pi-long-task pattern to pi-harness 5-level SSOT without polluting main session.

**Decision:** Port pi-long-task MIT to `src/goalSpec.ts` (GOAL_SPEC_SCHEMA_VERSION=1, create/validate/markdown), `src/goalLoop.ts` (GoalLoopState, DEFAULT_GOAL_LOOP_LIMITS {1,50,48h,3h,30min}, iterations/trace), `src/goalState.ts` (GoalStateStore with proper-lockfile on canonical `harness/goals/GOAL_SPEC.json` + run-scoped `tmp/pi-harness/goals/<runId>/`). Add hidden tool `pi_goal_task` (alias harness_goal_loop) with reviewer worker isolated to `tmp/pi-harness/<runId>/review/attempt-N/` parsing {decision: complete|incomplete|blocked|failed}.

**Consequences:** Canonical GOAL_SPEC survives reload/compaction; per-iteration TODOs isolated. Reviewer decision drives loop. No new harness phase.

---

## 2026-08-22: F5 Remote Read-Only Web View

**Status:** accepted

**Context:** TUI widget only visible in spawning terminal. Needed read-only remote view for phone/second laptop without mutating baseRevision or requiring SHH into project dir, reusing existing SSOT and widget rendering.

**Decision:** Add `src/remote.ts` with `buildRemoteState(projectDir)` (reads feature-list.json + GOAL_SPEC.json + widget via buildWidgetLines) and `createRemoteServer` on 127.0.0.1 ephemeral -> GET / HTML inline polling 2000ms + GET /api/harness JSON RemoteState + GET /api/health. Reads via readFileSync (no lock, no baseRevision bump). Add hidden tool `pi_harness_remote` (alias harness_remote) singleton per session; close on session_shutdown. No mutation endpoints, no auth beyond localhost bind.

**Consequences:** Read-only polling view via HTTP; concurrent fetches serialized, no file corruption, no baseRevision churn. Operator can expose via SSH tunnel if needed.

---

## 2026-08-22: F6 Resilient Self-Correction

**Status:** accepted

**Context:** Harness was forward-only (isValidTransition from+1) with single global model and no backward edge; long runs stalled after STALL_NO_CHANGE with no self-correction. Need bounded, configurable rework/replan/model-routing without infinite loops.

**Decision:** Add configurable optional self-correction read fresh each call: `harness/model-router.json` v1 {enabled,default,byDifficulty:{easy,moderate,difficult},master,byPhase,byRole,byTask,consultation:{enabled,maxPerTask,oneStepOnly,requireExhaustion},budgets:{maxReworksPerRun:3,maxReplansPerRun:2,maxReviewBounces:2}}, `harness/rework.json` + `harness/replan.json` with proper-lockfile+tmp+rename, `harness/config.json` {rework:{maxReworks:3,maxImpactDepth:3},replan:{maxReplans:2},unstuck:{strategies,hysteresisMs},review:{allowBackward,maxBounces:2,bounceRequiresDelta}}. Task difficulty easy|moderate|difficult + modelHint with priority task.modelHint > byTask > byDifficulty > byFeature > bySprint > byPhase > byRole > default; ladder easy→moderate→difficult→MASTER one-step consultation (MASTER never assigned). New modules `src/modelRouter.ts` (resolveModel/consultNext), `src/rework.ts` (startRework BFS depth 3 flip to rework ↷ bump baseRevision), `src/replan.ts` (amendPlan DAG guards maxReplans 2), `src/unstuck.ts` (chooseUnstuckStrategy retry→reframe→consult→rework→replan→master with fingerprint dedup/fileDelta/hysteresis/budgets), `src/review.ts` (shouldBounceToRework gate). Extend worker SpawnOpts.model injection and goalLoop reviewer model; extend remote RemoteState router+rework read-only. Widget rework amber ↷. Guards maxReworks 3 / maxReplans 2 / maxBounces 2 / maxPerTask 1 + fingerprint dedup + bounceRequiresDelta + hysteresis.

**Consequences:** Bounded backward edge with return-to-origin, mid-BUILD plan amend, per-task model escalation, review bounce only when fileDelta true. All optional, exposed read-only via remote, no endless loops.

---


## 2026-08-22: F7 Ops Activation — Router Live + Auto-Bounce/Unstuck + Rubric + E2E

**Status:** accepted

**Context:** F6 shipped configurable self-correction (`model-router.json` v1 `enabled:false`, `src/modelRouter.ts` `resolveModel`/`consultNext`, `src/rework.ts` `startRework` BFS, `src/replan.ts` `amendPlan`, `src/unstuck.ts` `chooseUnstuckStrategy`, `src/review.ts` `shouldBounceToRework`, `src/remote.ts` `router`/`rework`, `src/widget.ts` `rework ↷`) but left router disabled and `turn_end` only `gates.runChecks` notify — no auto `shouldBounceToRework`/`chooseUnstuckStrategy`, rubric still F1 9/12 (2026-08-21, 72 lines), `harness/config.json:git.branch` stale `feature/pi-harness-f6-resilient` vs `main`, and no live E2E proof of `consult->rework ↷->return-to-origin` via `GET /api/harness`.

**Decision:** Activate ops: flip `harness/model-router.json` `enabled:false->true` (fresh-read each call, `loadRouterConfig` merges `DEFAULT_ROUTER`), wire `extensions/harness-enforcer/index.ts` `turn_end` `+ F7 auto-bounce/unstuck` to on FAIL compute `fileDelta` via `git diff --quiet`/`--cached`/`status --porcelain`, if `review` call `shouldBounceToRework({fileDelta})` notify `↷ rework eligible` + `appendEntry harness:rework-eligible`, then always call `chooseUnstuckStrategy({fileDelta})` notify `unstuck suggest <strategy> -> <nextModel>` + `appendEntry harness:unstuck` — both budgets/hysteresis/fileDelta guarded, no `sendUserMessage`. Sync `harness/config.json:git.branch` to `feature/pi-harness-f7-ops`, rewrite `harness/evaluator-rubric.md` to v1.1.0 F6 12/12 (2026-08-22, 62 lines, 6 dimensions 2 each, 12 suites evidence, Code Review two axes). Prove live on `tmp` clone: `resolveModel` ladder, `consultNext` one-step to MASTER, `shouldBounceToRework` fileDelta gate, `chooseUnstuckStrategy` dedup/hysteresis, `computeImpact` BFS, `startRework` flip+bump+`rework.json`, `buildRemoteState`/`createRemoteServer` `127.0.0.1:0` `GET /api/harness` `router`/`rework` + `GET /` HTML, `npx tsc --noEmit` clean, suites PASS. Bump `package.json` `1.1.0->1.2.0` + `CHANGELOG ##[1.2.0]` + `README` phase to `v1.2.0 F7`.

**Consequences:** Router ladder now live (task.modelHint > byTask > byDifficulty > ... > default), review bounce and unstuck suggestions auto-surface on validate FAIL with infinite-loop guards (`maxReworks 3` `maxReplans 2` `maxBounces 2` `maxPerTask 1` + dedup + requiresDelta + hysteresis). Rubric now 12/12 accept, branch hygiene restored, E2E self-correction demonstrated without polluting `baseRevision` (remote read-only). No new harness phase, no remote mutation, no new gate.

| Date | Decision | Status |
|------|----------|--------|
| 2026-08-20 | 5-Level Hierarchy + baseRevision Schema | accepted |
| 2026-08-21 | Atomic harness_task_list with Omission Deletion + Compaction Replay | accepted |
| 2026-08-21 | Duplicate src Logic in Extension for Runtime Isolation | accepted |
| 2026-08-21 | F2 Enforcer Auto-Loop Hardening | accepted |
| 2026-08-21 | F3 Worker Isolation per BUILD Task | accepted |
| 2026-08-22 | F4 Goal Loop with GOAL_SPEC.json + Reviewer Worker | accepted |
| 2026-08-22 | F5 Remote Read-Only Web View | accepted |
| 2026-08-22 | F6 Resilient Self-Correction | accepted |
| 2026-08-22 | F7 Ops Activation — Router Live + Auto-Bounce/Unstuck + Rubric + E2E | accepted |
