# Sprint Contract

## Scope (Generator proposes)

**I will build:**
F6 Resilient Self-Correction -> 1.1.0. Build harness/model-router.json v1 (enabled, default, byDifficulty easy|moderate|difficult, master never assigned, byPhase/byRole/byTask, consultation maxPerTask1 oneStepOnly requireExhaustion, budgets maxReworks3 maxReplans2 maxBounces2) + harness/rework.json + harness/config.json rework/replan/unstuck/review; add src/modelRouter.ts resolveModel+consultNext, src/rework.ts startRework impact BFS dependsOn baseRevision bump return-to-origin, src/replan.ts amendPlan, src/unstuck.ts chooseUnstuckStrategy (retry->reframe->consult->rework->replan->master); extend src/worker.ts SpawnOpts.model per-task isolation, goalLoop reviewer model routing, widget rework status \u21b7 amber, remote GET /api/harness read-only router+rework; all fresh-read, optional, budgets guard infinite loops.

**I will NOT build:**
No endless loops beyond budgets, no multi-step chain consult (one-step only), no MASTER direct assignment, no new harness phases/gates, no remote mutation beyond read-only GETs, no QR beyond SSH.

## Verification Criteria (Generator proposes)

npx tsc --noEmit passes; src/modelRouter.ts src/rework.ts src/replan.ts src/unstuck.ts exist with resolveModel/consultNext/startRework/amendPlan/chooseUnstuckStrategy, unit tests tests/modelRouter/rework/replan/unstuck.test.ts passing
Self-correction demonstrated: model-router.json disabled->enabled toggled fresh each call, startRework flips rework \u21b7 and writes harness/rework.json with returnFeature/returnTask/impacted[] + baseRevision bump, amendPlan adds task mid-BUILD guard maxReplans2, review bounce only when fileDelta true else ignored, all read-only via GET /api/harness
package.json 1.1.0 and CHANGELOG ## [1.1.0]; enforcer tsc clean no sendUserMessage, exposes routing via pi_harness_remote singleton and harness_spawn_worker model passthrough; harness_task_list still baseRevision optimistic with rework status and difficulty/modelHint optional

## Evaluator Review (Evaluator fills in)

- [x] Scope is clear and bounded: yes — src/modelRouter.ts + src/rework.ts + src/replan.ts + src/unstuck.ts with harness/model-router.json v1 + harness/rework.json + config rework/replan/unstuck/review; worker SpawnOpts.model, goalLoop reviewer routing, widget rework ↷
- [x] Verification criteria are sufficient: yes — tsc + 4 test suites (priority ladder MASTER never assigned, impact BFS, maxReworks guard, fingerprint dedup, bounceRequiresDelta) + toggle fresh-read demo + baseRevision bump + amendPlan guard + remote read-only
- [x] Exclusions are reasonable: yes — endless loops capped by budgets, no multi-step consult, no MASTER assignment, no new phases, no remote mutation beyond GETs

Agreed.





## Agreement Status

**Status:** Agreed
**Negotiation rounds:** 2/5


