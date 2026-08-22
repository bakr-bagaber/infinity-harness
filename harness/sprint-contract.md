# Sprint Contract — pi-harness F4 v0.5.0

## Scope (Generator proposes)

**I will build:**
F4 Goal Loop with GOAL_SPEC.json + Reviewer Worker (v0.5.0). Port `pi-long-task` `goal_spec.ts` → `src/goalSpec.ts` (`GOAL_SPEC_SCHEMA_VERSION=1`, `GoalSpecification`, `createGoalSpecification`, `validateGoalSpecification`, `goalSpecificationToMarkdown`), `goal_loop.ts` → `src/goalLoop.ts` (`GoalLoopState`, `DEFAULT_GOAL_LOOP_LIMITS {1,50,48h,3h,30min}`, `createGoalLoopState`, `startGoalIteration`, `recordGeneratedTodo`, `recordWorkerResult`, `recordReviewerResult`, `goalLoopStopReason`, `validateGoalLoopState`), `goal_state.ts` → `src/goalState.ts` (`GoalStateStore` with `paths {goalRunDir,statePath,tracePath,resultPath,goalSpecPath,iterationsDir}`, `ensureRunDir`, `saveState/loadState`, `saveGoalSpecification`, `appendTrace`, `writeIterationSnapshot`, atomic `tmp+rename` + `proper-lockfile` on `harness/goals/GOAL_SPEC.json`). Persist canonical `harness/goals/GOAL_SPEC.json` and run-scoped `tmp/pi-harness/goals/<runId>/GOAL_STATE.json` + `GOAL_TRACE.jsonl` + `iterations/<nn>/` + reviewer worker `tmp/pi-harness/<runId>/review/attempt-1/{prompt.md,output.log,fingerprint.json}` via `src/worker.ts` `spawnIsolatedWorker` `{promptfile}`. Wire `extensions/harness-enforcer/index.ts` hidden tool `pi_goal_task` (alias `harness_goal_loop`) delegating to `src/goalLoop.ts` + `src/goalState.ts` + isolated reviewer worker. Keep 5-level widget and `harness_task_list` atomic intact; reuse `define→ship` phases.

**I will NOT build:**
Remote web view `/pi-harness:remote` QR push (F5), new harness phases or gates beyond `define→ship`, `pi --loop` daemon beyond per-task/review isolation.

## Verification Criteria (Generator proposes)

1. `npx tsc --noEmit` passes; `src/goalSpec.ts`, `src/goalLoop.ts`, `src/goalState.ts` exist with spec/loop/state helpers, unit tests `tests/goalSpec.test.ts`, `tests/goalLoop.test.ts`, `tests/goalState.test.ts` passing (create spec, validate, markdown, create loop, start iteration, recordGeneratedTodo/worker/reviewer, limits min/max, timeout, cancellation, trace, persistence).
2. Goal persistence demonstrated: `GoalSpecification` → canonical `harness/goals/GOAL_SPEC.json` via `GoalStateStore` with `proper-lockfile` on that path (concurrent writers serialized, `feature-list.json` not corrupted); loop run writes `tmp/pi-harness/goals/<runId>/GOAL_STATE.json` + `GOAL_TRACE.jsonl` + `iterations/<nn>/` with `GOAL_SPEC.json` mirrored and reviewer worker isolated to `tmp/pi-harness/<runId>/review/attempt-1/{prompt.md,output.log,fingerprint.json}`.
3. `package.json` version is `0.5.0` and `CHANGELOG.md` has `## [0.5.0]` entry describing goal loop; enforcer still `tsc` clean with no `sendUserMessage` mid-stream regression and exposes `pi_goal_task` tool delegating via `spawnIsolatedWorker`.

## Evaluator Review (Evaluator fills in)

- [x] Scope is clear and bounded: yes — only three goal modules + `harness/goals/GOAL_SPEC.json` + `tmp/pi-harness/goals/` + enforcer `pi_goal_task`, no remote/phases.
- [x] Verification criteria are sufficient: yes — `tsc` + 3 unit test suites + isolated persistence artifact + version/changelog + enforcer tool.
- [x] Exclusions are reasonable: yes — F5 remote deferred.

Agreed.

## Agreement Status

**Status:** Agreed
**Negotiation rounds:** 1/5
