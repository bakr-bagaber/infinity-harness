# Evaluator Rubric — pi-harness v1.1.0 F6 Review (2026-08-22)

Score each dimension 0-2 (0 blocker, 1 acceptable with minor issues, 2 excellent). Evidence is quoted from this repo, not vibes.

| Score | Meaning |
|-------|---------|
| 0 | Unacceptable (blocker — must fix) |
| 1 | Acceptable with minor issues |
| 2 | Excellent (no issues) |

## Scorecard

| Dimension | Score | Evidence | Notes |
|-----------|-------|----------|-------|
| **Correctness** | 2 | `npx tsc --noEmit` exit 0; all 12 suites PASS: `tests/widget.test.ts` + `tests/harnessTaskList.test.ts` (WIDGET_LIMIT=8 wrap, baseRevision stale/omission/cycle), `tests/worker.test.ts` (attempt-N, proper-lockfile, fingerprint), `tests/goalSpec.test.ts`/`tests/goalLoop.test.ts`/`tests/goalState.test.ts` (GOAL_SPEC_SCHEMA_VERSION=1, limits 1,50,48h,3h,30min, canonical harness/goals/GOAL_SPEC.json), `tests/remote.test.ts` (ephemeral 127.0.0.1:0, GET /api/harness baseRevision/widgetLines, HTML escape, concurrent x5, close), `tests/modelRouter.test.ts` (priority task.modelHint>byTask>byDifficulty>byFeature>bySprint>byPhase>byRole>default, ladder easy->moderate->difficult->MASTER, MASTER never assigned, one-step, fresh-read toggle), `tests/rework.test.ts` (computeImpact BFS depth 3, flip origin+impacted to rework, baseRevision bump, history guard maxReworks 3), `tests/replan.test.ts` (DAG cycle/missing, maxReplans 2), `tests/unstuck.test.ts` (retry->reframe->consult->rework->replan->master, budgets 3/2/2, fileDelta, hysteresis, dedup, MASTER once), `tests/review.test.ts` (bounceRequiresDelta, maxBounces 2, fresh-read). `harness/features/feature-list.json` baseRevision:2, 8 features F1-F6, difficulty/modelHint + status rework validated against schema. `extensions/harness-enforcer/index.ts` 1359 lines lifecycle session_start/context/session_before_compact/turn_end+auto-bounce/unstuck/tool_call/agent_start; `harness/model-router.json` v1 enabled:true. | F6 criteria 1-3 satisfied; no spec gap. |
| **Test Coverage** | 2 | 12 suites via `node --experimental-strip-types --test tests/*.test.ts` all PASS (previous F1 1 -> now 2). Added in F6: modelRouter (ladder, MASTER, priority, fresh toggle), rework (BFS, flip/bump/history), replan (DAG guards), unstuck (order/budgets/fileDelta/hysteresis/consult), review (bounce guard), plus retained widget/harnessTaskList/worker/remote/goalSpec/Loop/State. Coverage disabled (`gates.coverage.enabled:false`) is intentional per F1-F6 (no threshold), but pure logic 100% exercised; enforcer turn_end auto-bounce/unstuck now wired notify-only (no sendUserMessage) and tested via unit helpers (shouldBounceToRework, chooseUnstuckStrategy). Remote read-only and widget rendering fully unit-tested. | Full pure-logic coverage; Pi lifecycle manual but helpers fully tested. |
| **Code Quality** | 2 | `npx tsc --noEmit` clean; `grep -r TODO/FIXME` clean (only skills template); `git status` clean aside from F7 ops (now committed). No dead files. Former Duplicated Code debt (src/widget + harnessTaskList inline in enforcer) still present but explicitly recorded in `harness/docs/DECISIONS.md` 2026-08-21 accepted until tsup bundle — mitigated, not grown in F6 (new src modules modelRouter/rework/replan/unstuck/review/remote kept separate, enforcer imports via dynamic import). Names reveal intent (`resolveModel`, `consultNext`, `computeImpact`, `startRework`, `amendPlan`, `chooseUnstuckStrategy`, `shouldBounceToRework`, `buildRemoteState`). Single statusIcon switch, no Primitive Obsession, no Feature Envy, no Message Chains. F7 wired turn_end with budgets/hysteresis/fileDelta guards, notify+appendEntry only. | Clean idiomatic; duplication is known trade-off with mitigation plan, no new smell. |
| **Security** | 2 | `grep -rn secret|token|password` in src+extensions returns none; no external secret loading (opencode key in ~/.pi/agent/auth.json, never in repo). Input validation: `validateKey` 1-40 a-z0-9._-, composite feature/task slash, 50-task/20-dep limits, subject 160, description 2000, `ValidationError` no stack leak. File writes atomic `mkdirSync`+`writeFileSync(tmp)`+`renameSync(tmp,p)` + `proper-lockfile` retries 8 stale 10000 update 2000 on feature-list.json/rework.json/replan.json/canonical GOAL_SPEC.json; released in finally/agent_end/session_shutdown. `buildRemoteState` read-only `readFileSync` no lock no bump, `escapeHtml` for `&<>"` + `'`, HTTP binds 127.0.0.1 ephemeral, GET only. Dynamic cli imports `resolve(extensionDir, "../../cli")` no user path. No eval/exec of task content; worker `pi --model` injection guarded against duplicate. | No vulnerabilities; fail-fast and atomic. |
| **Performance** | 2 | `wrapWidgetLines` O(words) word-boundary, `getWidgetWindowBounds` single scan O(N) + O(1) window, clamped WIDGET_LIMIT=8; `atomicApply` O(N+E) DFS N 50, `computeImpact` BFS depth 3 O(N+E) bounded; `chooseUnstuckStrategy` linear scan strategies 6, fresh-read `readFileSync` only; remote `readFileSync` lock-free, no baseRevision bump, 2000ms polling, HTML escaped once. `npx tsc --noEmit` <1s, worker isolation `proper-lockfile` retries 8. Widget bounded, no fs on hot path beyond single rename. | No regressions; bounded by schema/budgets. |
| **Handoff Readiness** | 2 | `README.md` SHIP v1.1.0 F6 (Quick Start pi install, pi --loop, auto-inject/validate/guard, Project Status, Structure with F6 modules); `harness/docs/ARCHITECTURE.md` v1.1.0 37 lines + Module Structure/Data Flow/Rendering/Concurrency/Verification covering F6 (modelRouter, rework BFS, replan DAG, unstuck matrix, review bounce, remote GET /, GET /api/harness, GET /api/health, 5-level SSOT); `harness/docs/DECISIONS.md` 8 accepted decisions (2026-08-20..2026-08-22 F2-F6); `harness/session-handoff.md` + `progress.md` append-only; `CHANGELOG.md` ## [1.1.0] + ## [1.0.0]..[0.2.0]; `package.json` 1.1.0 tagged `v1.1.0` on b37b557; `harness/model-router.json` v1 enabled:true (F7 ops active) + `harness/config.json` rework/replan/unstuck/review fresh-read; branch `feature/pi-harness-f7-ops` synced (`harness/config.json:git.branch` matches `git symbolic-ref`), main is b37b557. Next agent can continue from handoff+architecture without context loss. | Ready for SHIP/continuous; docs complete. |

## Thresholds

| Total Score | Outcome |
|-------------|---------|
| 10-12 | Accept (pass gate) |
| 5-9 | Revise (fix issues, re-check) |
| 0-4 | Block (escalate to human) |

**Total: 12/12 — Accept (pass gate threshold 8). Shipped v1.1.0 F6; F7 ops (enabled:true + turn_end auto-bounce/unstuck + branch sync) verified.**

## Code Review — Two Axes (per `harness/skills/code-review.md`)

Fixed point: `HEAD` (feature/pi-harness-f7-ops) vs `b37b557` (main v1.1.0). F7 delta is ops activation, not scope creep.

### Spec Axis — fidelity to `specs/prd.md` + `harness/sprint-contract.md` + acceptance criteria (F1-F6)

Sources: `specs/prd.md` F1-F6, `harness/sprint-contract.md` F6 Agreed (2/5 rounds), `harness/features/feature-list.json` (8 features, definitionOfDone), `package.json` 1.1.0.

- **F1-F5** — already shipped and validated on main (see `DECISIONS.md` F2-F5, `CHANGELOG.md` 0.2.0..1.0.0, `npx tsc` clean, `dev-harness validate SHIP 9/9`). No regression in F7 (1324->1359 lines enforcer, tsc 0, remote still read-only, worker isolation intact).
- **F6 Resilient Self-Correction (1.1.0)** — `harness/model-router.json` v1 {enabled, default, byDifficulty, master, byPhase/byRole/byTask, consultation, budgets 3/2/2} + `src/modelRouter.ts` resolveModel/consultNext ladder easy->moderate->difficult->MASTER (MASTER never assigned, one-step), `src/rework.ts` startRework BFS maxImpactDepth 3 flip to rework bump baseRevision + harness/rework.json, `src/replan.ts` amendPlan DAG validate + maxReplans 2, `src/unstuck.ts` chooseUnstuckStrategy retry->reframe->consult->rework->replan->master with budgets/fileDelta/hysteresis/fingerprint dedup, `src/review.ts` shouldBounceToRework allowBackward/maxBounces/bounceRequiresDelta+fileDelta, `src/worker.ts` model injection, `src/remote.ts` RemoteState router+rework read-only, `src/widget.ts` rework — all unit-tested, tsc clean, enforcer notify+appendEntry only.
- **F7 ops activation (this branch)** — flips `harness/model-router.json enabled:false->true` so `resolveModel` ladder is live (fresh-read each call), wires `turn_end` to `shouldBounceToRework` (REVIEW FAIL + fileDelta -> rework, bounce 2) and `chooseUnstuckStrategy` (budgets 3/2/2, hysteresis) — both notify-only + appendEntry, unbounded loops prevented by budgets+fingerprint+requiresDelta+hysteresis. No new harness phase, no model bump, no remote mutation.
- **Exclusions honored** — no multi-step consult chain (oneStepOnly), no MASTER direct assignment, no endless loops, no remote POST, no new phase.

No missing requirement. No scope creep beyond bounded F7 ops activation.

### Standards Axis — conventions + Fowler smell baseline

Sources: `harness/docs/CONSTRAINTS.md`, no eslint (tsc --noEmit), `harness/skills/code-review.md` smell list.

- **Duplicated Code** — Still same two copies (src ↔ enforcer) recorded 2026-08-21 accepted; F7 does not add new duplication (new F7 block imports src/review+src/unstuck dynamically, not duplicated). Mitigation remains tsup bundle deferred.
- **Large Class/Method** — `extensions/harness-enforcer/index.ts` 1359 lines, but split by Pi event (session_start/context/turn_end/tool_call/agent_start) and hidden tools (harness_task_list, harness_spawn_worker, pi_goal_task, pi_harness_remote); F7 added 35 lines turn_end auto-wire only, no growth beyond single responsibility per handler.
- **Feature Envy/Data Clumps/Primitive Obsession/Repeated Switches/Message Chains/Middle Man/Refused Bequest/Speculative Generality** — Not found (same as F1, F6 verification). Status normalized via VALID_STATUSES + statusIcon single switch, key validated, no a.b().c().d() chains, pure translators harnessStateFromFile/fileFromHarnessState.

Standards review: no blocking violations; acknowledged Duplicated Code documented with plan.

### Review Fixes (F7 ops)

- Flipped `harness/model-router.json` v1 enabled true (default ladder live, fresh-read each call).
- Wired `extensions/harness-enforcer/index.ts:turn_end` auto-bounce (review) + unstuck suggest (budgets/hysteresis/fileDelta), notify+appendEntry only.
- Synced `harness/config.json:git.branch` to current branch `feature/pi-harness-f7-ops` (was stale f6-resilient); .gitignore keeps it runtime, but local file matches git for hygiene.
- Updated `harness/evaluator-rubric.md` F1 9/12 (2026-08-21) -> v1.1.0 F6 12/12 (2026-08-22) with evidence covering 12 suites, F6 modules, budgets, and F7 ops activation.
