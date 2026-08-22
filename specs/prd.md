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

## F3 — Worker Isolation per BUILD Task (shipped v0.4.0)

**Problem:** `BUILD` tasks currently run in the main agent context. A faulty task can pollute the main session (dirty `harness/config.json` `gateHistory`, leaked env, half-written `feature-list.json`), and parallel `dev-harness run` workers can corrupt shared state. The dummy harness at `/tmp/pi-harness-dummy` already proved a fresh `pi --print` (`pi -p`) per task with attempt history works.

**Solution:** Fresh isolated worker per BUILD task.

* New module `src/worker.ts` (pure, tested): `createWorkerRunDir`, `spawnIsolatedWorker`, `recordAttempt`, attempt history to `tmp/pi-harness/<run-id>/<featureId>/<taskId>/attempt-N/{prompt.md, output.log, fingerprint.json}`. Uses `proper-lockfile` on `harness/features/feature-list.json` and `harness/config.json` so concurrent workers do not corrupt `baseRevision`. Preserves 5-level fields through file helpers.
* Integration point 1 — `extensions/harness-enforcer/index.ts`: expose `harness_spawn_worker` hidden helper (or just reuse `src/worker.ts` logic) so Pi can request an isolated run without touching main context. The extension itself stays notify-only; the worker is invoked by `dev-harness run` or manually via `pi --print` loop.
* Integration point 2 — `harness/config.json` `run.agents.pi.cmd` remains `pi --provider opencode --model opencode/muse-spark-1.2-contributor-free --thinking high -p "$(cat {promptfile})"` but the run driver now writes per-task `tmp/pi-harness/<run-id>/` directories and passes `{promptfile}` isolated per attempt. Existing `dev-harness run` loop in `dev-harness/cli/lib` already isolates via `git checkout -b run/<id>`; F3 adds filesystem isolation and attempt history.
* No new harness phase; reuse `define → plan → build → verify → review → ship`. No `GOAL_SPEC.json` yet (F4), no remote yet (F5).

## F4 — Goal Loop with GOAL_SPEC.json + Reviewer Worker (this sprint, v0.5.0)

**Problem:** `pi-harness` can enforce a 5-level `Goal→Feature→Sprint→Task→Subtask` hierarchy and isolate each `BUILD` task in `tmp/pi-harness/<run-id>/`, but it has no way to turn a high-level natural-language goal (e.g. "ship a checklist app") into a persisted specification and then iterate on it until a reviewer agrees it is done. The reference implementation `pi-long-task` solves this with a goal loop: `GOAL_SPEC.json` + per-iteration `GENERATED_TODO.md` + isolated worker sessions + reviewer pass + `GOAL_STATE.json` trace, running `minIterations..maxIterations` with timeouts. `pi-harness` needs a Pi-native port of that loop re-pointed at its own 5-level SSOT (`harness/goals/GOAL_SPEC.json` ↔ `harness/features/feature-list.json` `goals/sprints/features`) and reusing `src/worker.ts` isolation so the main Pi session is never polluted.

**Solution:** Goal loop as three pure modules plus enforcer wiring — reuse, do not rewrite.

* **New module `src/goalSpec.ts` (pure, tested):** port `pi-long-task/src/goal_spec.ts` (MIT) re-pointed to `pi-harness`. Exports `GOAL_SPEC_SCHEMA_VERSION=1`, `GoalSpecification` (schemaVersion, goalRunId, originalGoal, summary, traceability, scopedRequirements `{inScope,outOfScope,assumptions,openQuestions}`, milestones, acceptanceCriteria, verificationGates, design/product constraints, definitionOfDone), `createGoalSpecification({goalRunId,originalGoal,...})`, `validateGoalSpecification`, `goalSpecificationToMarkdown`. Validates every field, enforces traceability matches, supports `discovery_consolidation` source for future discovery role outputs.
* **New module `src/goalLoop.ts` (pure, tested):** port `pi-long-task/src/goal_loop.ts` (MIT). Exports `GoalLoopState` (`schemaVersion, goalRunId, goalRunDir, goal, status {running|done|partial|blocked|failed|cancelled}, phase {goal_received|todo_generated|todo_executed|reviewed|complete|cancelled|failed}, limits {minIterations,maxIterations,timeoutMs,iterationTimeoutMs,reviewerTimeoutMs}, iterations[], trace[]`), `DEFAULT_GOAL_LOOP_LIMITS {1,50,48h,3h,30min}`, `createGoalLoopState`, `normalizeGoalLoopLimits`, `startGoalIteration`, `recordGeneratedTodo`, `recordWorkerResult`, `recordReviewerResult`, `failGoalLoop`, `cancelGoalLoop`, `goalLoopStopReason`, `validateGoalLoopState`. Guards `min≤max`, deadline expiry, cancellation, and enforces minimum iterations before `complete`.
* **New module `src/goalState.ts` (pure, tested):** port `pi-long-task/src/goal_state.ts` (MIT) re-pointed to `tmp/pi-harness/goals/<runId>/` and canonical `harness/goals/GOAL_SPEC.json`. Exports `GoalStateStore` with `paths {goalRunDir,statePath,tracePath,resultPath,goalSpecPath,iterationsDir}`, `ensureRunDir`, `saveState/loadState`, `saveGoalSpecification/loadGoalSpecification/tryLoad`, `appendTrace`, `initializeResult`, `writeIterationSnapshot`, `iterationDir`. Atomic `writeFile tmp+rename`, `proper-lockfile` on `harness/goals/GOAL_SPEC.json` when writing canonical spec so concurrent goal loops do not corrupt it.
* **Integration point — `extensions/harness-enforcer/index.ts`:** stays `notify` + `appendEntry` only (no `sendUserMessage` mid-stream). Adds hidden tool `pi_goal_task` (alias `harness_goal_loop`) delegating to `src/goalLoop.ts` + `src/goalState.ts` + `src/worker.ts` `spawnIsolatedWorker` for the reviewer pass: a reviewer worker runs in `tmp/pi-harness/<runId>/review/attempt-N/{prompt.md,output.log,fingerprint.json}` with `{promptfile}` isolation, parsed into `{decision: complete|incomplete|blocked|failed, remainingWork[]}`. Main session persists `GOAL_STATE.json` + `GOAL_TRACE.jsonl` under `tmp/pi-harness/goals/<runId>/` and mirrors latest `GOAL_SPEC.json` to `harness/goals/GOAL_SPEC.json` (created, `harness/goals/` dir added, `.gitignore` already ignores `tmp/`).
* **Integration point — persistence:** canonical `harness/goals/GOAL_SPEC.json` keeps the 5-level `Goal` alive across `/reload` + compaction; run-scoped `tmp/pi-harness/goals/<runId>/` keeps per-iteration TODOs/results isolated like `pi-long-task` `tmp/pi-goal-task/<runId>/`. Worker attempt history still uses `tmp/pi-harness/<run-id>/<feature>/<task>/attempt-N/` from F3. No new harness phase; reuse `define→plan→build→verify→review→ship`. No `/remote` yet (F5).

## Verification Criteria (F4)

1. `npx tsc --noEmit` passes; `src/goalSpec.ts`, `src/goalLoop.ts`, `src/goalState.ts` exist with spec/loop/state helpers, unit tests `tests/goalSpec.test.ts`, `tests/goalLoop.test.ts`, `tests/goalState.test.ts` passing (create spec, validate, markdown, create loop, start iteration, recordGeneratedTodo/worker/reviewer, limits min/max, timeout, cancellation, trace, persistence).
2. Goal persistence demonstrated: creating a `GoalSpecification` persists canonical `harness/goals/GOAL_SPEC.json` via `GoalStateStore` with `proper-lockfile` on that path (concurrent writers serialized, `baseRevision`/`feature-list.json` not corrupted); a loop run writes `tmp/pi-harness/goals/<runId>/GOAL_STATE.json` + `GOAL_TRACE.jsonl` + `iterations/<nn>/` with `GOAL_SPEC.json` mirrored and reviewer worker isolated to `tmp/pi-harness/<runId>/review/attempt-1/{prompt.md,output.log,fingerprint.json}`.
3. `package.json` version bumps to `0.5.0` and `CHANGELOG.md` has `## [0.5.0]` entry describing goal loop; `pi-harness` enforcer still loads (`extensions/harness-enforcer/index.ts` `tsc` clean, no `sendUserMessage` mid-stream regression) and exposes `pi_goal_task` tool delegating to `src/goalLoop.ts` via isolated reviewer worker.

## F5 — Remote Read-Only Web View → 1.0.0 (this sprint, v1.0.0)

**Problem:** `pi-harness` enforces the loop and shows a 5-level widget inside the Pi TUI, but offers no way to inspect harness state from another device without SSH. The harness artifacts already exist (`harness/features/feature-list.json` + `harness/goals/GOAL_SPEC.json` + `tmp/pi-harness/...` + widget lines), yet they are only visible inside the spawning terminal. A minimal read-only remote view would let a phone or second laptop poll progress safely while `tmp/` remains ignored and `baseRevision` stays untouched.

**Solution:** Read-only HTTP view that reuses existing SSOT and rendering.

* **New module `src/remote.ts` (pure, tested):** exports `RemoteOptions {projectDir, host?, port?}`, `RemoteState {baseRevision, features, goals, widgetLines, timestamp}`, `buildRemoteState(projectDir)` (reads `harness/features/feature-list.json` via `harnessStateFromFile` + optional `harness/goals/GOAL_SPEC.json` + computes `widgetLines` via `src/widget.ts` `buildWidgetLinesFromState`/`buildWidgetLines` with `WIDGET_LIMIT=8`), and `createRemoteServer(opts)` → `{url, host, port, close():Promise<void>}` using `node:http` `createServer` on `127.0.0.1` (ephemeral `0` → real port). Routes: `GET /` → static HTML (inline, no external deps, shows `Harness — baseRevision N`, `Progress: x/y`, widget `<pre>` block, feature/task table, `fetch(/api/harness)` polling every 2s, escaped HTML), `GET /api/harness` → JSON `RemoteState`, `GET /api/health` → `{ok:true, version}`. Reads are `readFileSync` with try/catch; no writes, no mutation, so `baseRevision` never increments via remote and no lock needed for reads (writes already use `proper-lockfile`+`tmp+rename`). `close()` stops server cleanly; URL printed via `ctx.ui.notify` when invoked through enforcer.

* **Tests `tests/remote.test.ts`:** start on `127.0.0.1:0`, fetch `/api/harness` → valid JSON shape `baseRevision` matches fixture, `features` array, `widgetLines` array length, `timestamp` ISO string; fetch `/` → HTML contains `pi-harness` + `baseRevision`; concurrent `fetch` x5 serialized; `close()` frees port (second `close` no throw); HTML escapes `subject` with `&<>"` safely.

* **Integration — `extensions/harness-enforcer/index.ts`:** stays `notify`+`appendEntry` only (no `sendUserMessage`). Adds hidden tool `pi_harness_remote` (alias `harness_remote`) with `{action: start|stop|status, port?, host?}` delegating to `src/remote.ts` `createRemoteServer`/`buildRemoteState`. `start` launches server and returns `{url, port}`; `stop` closes; `status` builds state without starting server. Server instance kept in module singleton, stopped on `session_shutdown` to avoid leaked handles. No QR dependency; URL is `http://127.0.0.1:<port>` and operator can expose via SSH tunnel if needed.

* No new harness phase; reuse `define→plan→build→verify→review→ship`. No auth beyond `127.0.0.1` bind (read-only, no secrets in payload — `GOAL_SPEC.json` already in repo). No mutation endpoints.

## Verification Criteria (F5)

1. `npx tsc --noEmit` passes; `src/remote.ts` exists with `createRemoteServer`/`buildRemoteState`, unit tests `tests/remote.test.ts` passing (start ephemeral, GET /api/harness shape with baseRevision/widgetLines/timestamp, GET / serves HTML containing harness title, concurrent fetches serialized, close frees port, HTML escaping).
2. Remote read-only demonstrated: start on `127.0.0.1:0`, `fetch(/api/harness)` reflects `harness/features/feature-list.json` `baseRevision` + computed widget lines without mutating the file, `fetch(/)` returns HTML with `Progress`/`Todos` and widget lines, `close()` stops server; repeated start/stop does not corrupt `baseRevision` or `feature-list.json`.
3. `package.json` version bumps to `1.0.0` and `CHANGELOG.md` has `## [1.0.0]` entry describing remote; enforcer still `tsc` clean with no `sendUserMessage` mid-stream regression and exposes `pi_harness_remote` (alias `harness_remote`) tool.

## Resolved Questions (F5 self-grill, autopilot)

- **Who uses this the moment it works?** Developer running `pi` with `pi-harness` watches long `GOAL_SPEC` loop from phone: `pi_harness_remote {action:"start",port:0}` → `http://127.0.0.1:PORT` → tail via SSH tunnel or `adb reverse`; no SSH into project dir needed.
- **What is OUT of scope this sprint?** Mutation via remote (no POST), auth/token beyond localhost bind, QR code generation/dependency, push notifications, new harness phases/gates, `pi --loop` daemon beyond per-task isolation, external hosting.
- **Smallest slice proving the concept?** `GET /api/harness` returning `baseRevision`+`widgetLines` from real `feature-list.json` and `GET /` rendering those lines + polling fetch — without it, there is no remote view at all.
- **What breaks first under bad input/no network/concurrent use?** Missing `feature-list.json` → `buildRemoteState` returns empty state with `baseRevision:0` not throw; invalid `port` → `EADDRINUSE` surfaced as `ValidationError`; concurrent `fetch` xN → Node http handles naturally, no shared mutable state beyond singleton server; reads use `readFileSync` so concurrent writes via `proper-lockfile` remain safe (stale read returns previous revision, never corrupt).
- **How will we KNOW it works?** `npx tsc --noEmit`, `npx tsx tests/remote.test.ts` (ephemeral port + fetch checks), manual `curl http://127.0.0.1:$PORT/api/harness | jq .baseRevision` before/after a `harness_task_list` call shows unchanged until tool mutates.
- **What existing code already does part of this?** `src/widget.ts` `buildWidgetLines`+`getWidgetWindowBounds` (rendering), `src/harnessTaskList.ts` `harnessStateFromFile` (file → state), `src/worker.ts`/`src/goalState.ts` `proper-lockfile` pattern (only needed on writes, reads stay lock-free), `extensions/harness-enforcer` hidden-tool pattern (`harness_spawn_worker`, `pi_goal_task`).

## Non-Goals (this sprint)

* No remote mutation (no POST /api/harness), no QR/external tunnel helper (operator uses SSH), no auth/token beyond localhost, no new harness phases/gates, no continuous daemon beyond enforcer `turn_end`+`session_before_compact` already shipped.

## Out of Scope for F1-F4 (done)

Worker isolation per BUILD task (F3) done, Goal loop `GOAL_SPEC.json` (F4) done — F5 is the final 1.0.0 slice (remote read-only view).

## Verification Criteria (F1 — historical)

1. `pi -e ./pi-harness` shows live widget in Pi TUI: `Goal → Feature → Sprint → Task → Subtask` with `○●◐⚠↷`, `Progress: 1/5`, `+2 more` when >8, `← #1` deps, survives `/reload` + `session_before_compact` (hidden checkpoint) + `/tree` (branch-aware replay from `toolResult.details` + `custom`).
2. `harness/features/feature-list.json` has `baseRevision`, `tasks` have `key`, `dependsOn`, `subtasks`; `harness_task_list` with stale `baseRevision` is rejected; omission deletes; `in_progress` with uncompleted dep is rejected; `dependsOn` cycle is rejected (unit tests).
3. `npm test` passes and `npx tsc --noEmit` passes; widget renders without truncation (wrap, not ellipsis) for long labels.

## Non-Goals (F1)

* No `pi-worker` per task yet (F3)
* No `GOAL_SPEC.json` generation yet (F4)
* No `/remote` yet (F5)
