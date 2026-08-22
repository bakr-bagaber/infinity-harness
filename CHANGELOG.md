# Changelog

All notable changes to `pi-harness` will be documented here.

## [1.2.0] - 2026-08-22

### Added
- **F7 Ops Activation -> 1.2.0:** flip `harness/model-router.json` `enabled:false->true` so `resolveModel` ladder `easy->moderate->difficult->MASTER` is live fresh-read each call (priority `task.modelHint > byTask > byDifficulty > byFeature > bySprint > byPhase > byRole > default`, `DEFAULT_ROUTER` safe defaults, `loadRouterConfig` merges, `consultNext` one-step to MASTER never directly assigned, `maxPerTask 1` `oneStepOnly` `requireExhaustion`). Wire `extensions/harness-enforcer/index.ts` `turn_end` `+ F7 auto-bounce/unstuck` to auto-call `shouldBounceToRework({projectDir,fileDelta})` on `review` FAIL (reads `harness/config.json` `review:{allowBackward true,maxBounces 2,bounceRequiresDelta true}` + `harness/rework.json` history, `fileDelta` via `git diff --quiet`/`--cached`/`status`, `maxBounces 2` guard) and `chooseUnstuckStrategy({projectDir,fileDelta})` on any FAIL (reads `harness/config.json` `rework/replan/unstuck/review` + `harness/model-router.json` `budgets:{maxReworksPerRun 3,maxReplansPerRun 2,maxReviewBounces 2}` `consultation`, order `retry->reframe->consult->rework->replan->master`, `hashLite` fingerprint dedup, `fileDelta+bounceRequiresDelta`, `hysteresisMs`, `oneStepOnly`, `requireExhaustion`, MASTER once per run) — both `notify` + `appendEntry` only (`harness:rework-eligible`, `harness:unstuck`) no `sendUserMessage` mid-stream, budgets/hysteresis/fileDelta guarded. Sync `harness/config.json:git.branch` to `feature/pi-harness-f7-ops` (was stale `f6-resilient`), update `harness/evaluator-rubric.md` F1 9/12 (2026-08-21, 72 lines) -> v1.1.0 F6 12/12 (2026-08-22, 62 lines) with evidence 12 suites `widget/harnessTaskList/worker/remote/goalSpec/Loop/State/modelRouter/rework/replan/unstuck/review`, F6 modules `modelRouter/rework BFS/replan DAG/unstuck matrix/review bounce/worker model/remote router+rework` + F7 ops `enabled:true` + `turn_end` wiring. Live E2E dogfood on `tmp` clone: `resolveModel` ladder `easy/moderate->free` `difficult->meta`, `consultNext` `easy->moderate` `difficult->MASTER` `overflow null`, `shouldBounceToRework` `noDelta false` `withDelta true`, `chooseUnstuckStrategy` `retry` `dedup->reframe` `noDelta rework blocked` `consult exhaustion`, `computeImpact` BFS depth 1->[b] 2->[b,c] 3->[b,c,d], `startRework` flips `rework-demo` + `rework-demo-2` to `rework` bumps `baseRevision 2->3` writes `harness/rework.json` `proper-lockfile+tmp+rename` `history`, `buildRemoteState`/`createRemoteServer` `127.0.0.1:0` `GET /api/harness` exposes `router:{enabled:true,budgets,byDifficulty}` + `rework:{active,impactedCount}` + `widgetLines`/`baseRevision` without bump, `GET /` HTML contains `pi-harness` + `Progress`, concurrent x5 serialized, close idempotent + re-bind, read-only `readFileSync` no lock no bump, `escapeHtml` `&<>"` + `'`, `npx tsc --noEmit` clean.

## [1.1.0] - 2026-08-22

### Added
- **F6 Resilient Self-Correction -> 1.1.0:** configurable, optional, fresh-read each call, exposed read-only via pi_harness_remote GET /api/harness without baseRevision bump or lock. Adds harness/model-router.json v1 {version:1,enabled,default,byDifficulty:{easy,moderate,difficult},master,byPhase,byRole,byTask,consultation:{enabled,maxPerTask:1,oneStepOnly,requireExhaustion},budgets:{maxReworksPerRun:3,maxReplansPerRun:2,maxReviewBounces:2}} with src/modelRouter.ts resolveModel and consultNext ladder easy->moderate->difficult->MASTER (MASTER never assigned, one-step). Adds harness/rework.json via src/rework.ts startRework forward BFS on dependsOn DAG limited maxImpactDepth 3, flips origin+impacted to rework ↷ amber via src/widget.ts/src/harnessTaskList.ts, bumps baseRevision, proper-lockfile+tmp+rename; loadRework/clearRework. Adds src/replan.ts amendPlan validates DAG no cycles/missing deps, guards maxReplansPerRun 2, proper-lockfile+tmp+rename. Adds src/unstuck.ts chooseUnstuckStrategy retry->reframe->consult->rework->replan->master with budgets, fingerprint dedup via hashLite, fileDelta+bounceRequiresDelta, hysteresis, oneStepOnly, requireExhaustion, MASTER once per run. Adds src/review.ts shouldBounceToRework fresh-read harness/config.json review allowBackward maxBounces 2 bounceRequiresDelta - REVIEW fail bounces to rework only when fileDelta true else ignored, guarded maxBounces. Extends src/worker.ts SpawnWorkerOpts.model fingerprint extra model plus pi --model injection and src/goalLoop.ts resolveReviewerModel; enforcer harness_spawn_worker and pi_goal_task pass model through. Extends src/remote.ts RemoteState router+rework read-only via readFileSync and schema status rework plus difficulty modelHint. No new harness phase, no endless loops (budgets+fingerprint+requiresDelta+hysteresis), npx tsc --noEmit clean, enforcer notify+appendEntry only no sendUserMessage, harness_task_list still baseRevision optimistic with rework status.
- harness/config.json adds rework:{enabled,maxReworks:3,maxImpactDepth:3}, replan:{allowMidBuildAmend,maxReplans:2}, unstuck:{strategies,hysteresisMs}, review:{allowBackward,maxBounces:2,bounceRequiresDelta} read fresh per call. tests/modelRouter.test.ts, tests/rework.test.ts, tests/replan.test.ts, tests/unstuck.test.ts, tests/review.test.ts passing.

## [1.0.0] - 2026-08-22

### Added
- **F5 Remote Read-Only Web View -> 1.0.0:** src/remote.ts with buildRemoteState(projectDir) + createRemoteServer({projectDir,host,port}) via node:http on 127.0.0.1 ephemeral -> GET / HTML inline polling (2000ms) + GET /api/harness JSON RemoteState {baseRevision,features,goals,widgetLines,timestamp} + GET /api/health {ok,version} using readFileSync (no baseRevision increment, no lock) and buildWidgetLines; buildHtml escapes (&,<,>,",') and lists Goals/Features tables with Progress. tests/remote.test.ts covers ephemeral port, shape baseRevision/widgetLines/timestamp, HTML contains pi-harness + baseRevision + Progress with escaping, concurrent x5 fetches serialized, close idempotent and frees port for re-bind, readOnly baseRevision not mutated.
- extensions/harness-enforcer now exposes pi_harness_remote (alias harness_remote) hidden tool {action:start|stop|status,port?,host?,projectDir?} delegating to src/remote.ts singleton per session; start launches ephemeral server -> {url,host,port}, status builds RemoteState without starting, stop closes; session_shutdown closes remoteServer; enforcer stays notify+appendEntry only, no sendUserMessage mid-stream regression, no baseRevision or feature-list.json corruption on repeated start/stop.

## [0.5.0] - 2026-08-22

### Added
- **F4 Goal Loop with GOAL_SPEC.json + Reviewer Worker:** ports pi-long-task goal loop to src/goalSpec.ts (GOAL_SPEC_SCHEMA_VERSION=1, createGoalSpecification/validateGoalSpecification/goalSpecificationToMarkdown), src/goalLoop.ts (GoalLoopState, DEFAULT_GOAL_LOOP_LIMITS {1,50,48h,3h,30min}, createGoalLoopState/normalizeGoalLoopLimits/startGoalIteration/recordGeneratedTodo/WorkerResult/ReviewerResult/goalLoopStopReason/validateGoalLoopState), src/goalState.ts (GoalStateStore with paths {goalRunDir,statePath,tracePath,resultPath,goalSpecPath,iterationsDir} -> tmp/pi-harness/goals/<runId>/, canonical harness/goals/GOAL_SPEC.json via proper-lockfile atomic tmp+rename, saveState/loadState/saveGoalSpecificationWithCanonical/appendTrace/writeIterationSnapshot); tests/goalSpec.test.ts, tests/goalLoop.test.ts, tests/goalState.test.ts covering create/validate/markdown, limits lifecycle reviewer terminal cancellation timeout max_iterations, persistence concurrent writers and baseRevision isolation.
- extensions/harness-enforcer now exposes pi_goal_task (alias harness_goal_loop) hidden tool delegating to src/goalLoop.ts+src/goalState.ts+src/worker.ts spawnIsolatedWorker; reviewer isolated to tmp/pi-harness/<runId>/review/attempt-N/{prompt.md,output.log,fingerprint.json} with decision parsing {decision: complete|incomplete|blocked|failed, remainingWork[]}; enforcer stays notify+appendEntry only, no sendUserMessage mid-stream regression.
- Canonical harness/goals/GOAL_SPEC.json mirrors run-scoped tmp/pi-harness/goals/<runId>/GOAL_SPEC.json with proper-lockfile so concurrent goal loops do not corrupt it; harness/goals/ created, tmp/ already ignored.

## [0.4.0] - 2026-08-21

### Added
- **F3 Worker Isolation per BUILD Task:** `src/worker.ts` with `createWorkerRunDir`, `spawnIsolatedWorker`, `recordAttempt`, `buildFingerprint`, `hashLite`, `proper-lockfile` isolation on `harness/features/feature-list.json` + `harness/config.json`; attempt history to `tmp/pi-harness/<run-id>/<feature>/<task>/attempt-N/{prompt.md,output.log,fingerprint.json}` preserving `baseRevision` and 5-level fields; `tests/worker.test.ts` covering dir creation, `attempt-N` increment, `proper-lockfile` concurrent writes, `baseRevision` preservation, `fingerprint.json` validity and `tmp/pi-harness` isolation.
- `extensions/harness-enforcer` now exposes `harness_spawn_worker` hidden tool delegating to `src/worker.ts` `spawnIsolatedWorker` so `dev-harness run` isolates per BUILD task via `tmp/pi-harness/<run-id>/` without leaking `gateHistory` to the main session; extension stays `notify`+`appendEntry` only, no `sendUserMessage` mid-stream regression.
- `tmp/` ignored (`tmp/pi-harness/` worker attempt history does not dirty the repo).

## [0.3.0] - 2026-08-21

### Fixed
- **Enforcer stream race (F1 hotfix):** `turn_end` no longer calls `sendUserMessage`/`sendMessage` mid-stream — now `notify`+`appendEntry` only, avoiding OpenAI Responses stream ended error during `high` thinking turns.
- **BUILD gate infinite dirty:** untracked harness runtime state (`harness/config.json`, `feature-list.json`, `progress.md`, `session-handoff.md` now ignored) so `gateHistory` appends do not block `phase next`.

### Added
- **F2 Enforcer Auto-Loop Hardening:** `session_start` auto-inject lightweight (`notify`+`widget`), `context` hidden checkpoint and periodic reminder every 3 calls, `session_before_compact` `appendEntry` checkpoint, `tool_call` guard blocks phase-skip without `PASS`, `high` not `xhigh` for `dev-harness run` workers.

## [0.2.0] - 2026-08-21

### Added
- **F1 Visual 5-Level Widget + baseRevision** — Pi TUI now shows `Goal → Feature → Sprint → Task → Subtask` with rolling window (`WIDGET_LIMIT=8`, `COMPLETED_CONTEXT=3`), `+3 more` overflow, `← #1` dependency numbers, and `Progress: x/y`.
- `harness/features/feature-list.json` extended to 5 levels: `baseRevision`, `goals[]`, `sprints[]`, `tasks[].key`/`dependsOn`/`subtasks[]` with JSON schema validation.
- `src/widget.ts` ported from `task-tracker` + `pi-long-task` (status icons `○●◐⚠↷`, section headers `▸ Feature`).
- `harness_task_list` tool skeleton with `baseRevision` optimistic concurrency placeholder (full atomic + hidden `harness:checkpoint` for compaction lands in v0.3.0).

### Fixed
- `pi-harness` enforcer `session_start` lightweight + `context` injection to avoid `already processing` during `dev-harness run` preflight.

## [0.1.0] - 2026-08-20
- Initial clean port from `dev-harness` `5.1.0` — `cli`/`skills`/`prompts` via symlink, `extensions/harness-enforcer` with `session_start`/`turn_end`/`tool_call`/`proper-lockfile`.
