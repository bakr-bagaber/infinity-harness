# Decisions

Architectural decisions and the reasoning behind them. Outcomes without reasons are useless to the
next person — record why, and what it cost.

---

## 1. The gate is the only referee

**Context.** An agent asked whether its work is finished will say yes. Repeatedly, and wrongly, over
a long run.

**Decision.** Completion is decided by deterministic checks that are a pure function of the project
on disk. The agent cannot mark its own work complete, and the extension blocks hand-edits to
`currentPhase` while the gate is failing.

**Cost.** Gates must be cheap enough to run every iteration, and must never fail for a reason the
agent cannot fix — a gate that deadlocks the loop is worse than no gate. Hence advisory checks:
an unconfigured lint command is reported, not enforced.

---

## 2. Phases move forward, one step at a time

**Decision.** `isValidTransition` permits only the next enabled phase, or re-running the current one.
Backward movement exists only as an explicit, budgeted rework that records why it happened.

**Why.** It removes a decision the model is bad at. Without it, a struggling agent reorders the
pipeline to reach a phase whose gate it can pass.

---

## 3. The plan is submitted whole; omission means deletion

**Decision.** `infinity_plan` takes the complete task list, not a patch.

**Why.** Incremental edits require the model to track what exists. Over hours it stops being able to:
it re-adds deleted tasks, forgets others, and the file diverges from reality. A full submission is
self-correcting, and one unambiguous rule beats a set of merge semantics nobody can predict.

**Cost.** Every write carries the whole plan. Capped at 200 tasks, which is far beyond a sensible
sprint.

---

## 4. `baseRevision` is not a compare-and-swap

**Context.** The original write did read → check `baseRevision` → write, with no mutual exclusion,
and the docs claimed this protected parallel workers. It does not. Two processes that both read
revision N both pass the check and both write N+1. Measured: 2 lost updates in a 6-way fan-out.

**Decision.** `writeTaskList` holds an exclusive lock across the whole read-apply-write and fails
closed — a write that cannot take the lock is refused, not raced.

**Cost.** Plan writes serialise. The critical section is milliseconds, so this is not felt; a
`LockTimeoutError` is retryable and names the stuck lock.

**Also.** The sync lock uses `<path>.ilock`. `proper-lockfile` owns `<path>.lock` and it is a
directory there too, so sharing the name made a nested async+sync lock deadlock against itself.

---

## 5. One implementation, in `src/`

**Context.** The extension carried inlined copies of the plan engine and the widget. The tests
exercised `src/`; the shipped code path never called it. The two drifted, and the drift was
invisible because the suite was green. The same pattern later reappeared in `rework.ts` and
`replan.ts`, which kept private plan loaders — and one of them mishandled status aliases, rejecting
every amendment to a plan that used `"done"`.

**Decision.** `src/` is the single implementation. The extension owns pi's lifecycle and nothing
else. A private `loadFeatureList` is a bug, not a shortcut.

---

## 6. Knowing when to stop is the product

**Decision.** The loop halts on no-progress, wall clock, iteration count, retry budgets, or a human
brake — and every stop names its reason.

**Why.** Continuing is trivial. The default failure mode of an autonomous loop with a weak model is
re-running a failing gate against an unchanged tree until the budget is gone. The no-progress
detector compares a fingerprint of the working tree and the plan; the first failing iteration is a
baseline and never counts as a stall.

---

## 7. Ship vendor-neutral defaults

**Context.** The router shipped enabled, with one third-party vendor's model ids hardcoded in every
slot.

**Decision.** Routing is disabled by default and every slot is empty, meaning "use whatever model pi
is already configured with". Installing an extension must never silently redirect someone's work to
a model they did not choose.

---

## 8. The dashboard cannot perturb the run

**Decision.** Read-only, loopback-only, and it does not run the gate — it reports the last recorded
verdict instead.

**Why.** Running lint and the test suite because someone opened a web page is a surprising and
expensive side effect. And a page rendering model output on a public interface leaks the project;
binding elsewhere requires an explicit opt-in, and the CSP is tight enough that an escaping slip
cannot become script execution.

---

## 9. The canonical plan is `harness/plan.json`

**Context.** The plan lived as `harness/features/feature-list.json`, a nested path that leaked storage layout into every reader. V3 renamed the canonical to `harness/plan.json` and kept the legacy path as a read-through + write-through alias with a `movedTo` stub. Reads try canonical first, then legacy; writes materialise both so `loadFeatureList` callers and `plan.json` callers see the same truth. One implementation in `src/core/featureList.ts`, one alias in `src/core/plan.ts`.

**Cost.** Dual-write until all callers migrate; `.bak` handling for both paths.

---

## 10. Config tiers + limits are validated and clamped with a warning, not an exception

**Decision.** `loadConfig` validates `pilot`, `limits`, `tiers`, and `execution.isolation`. Unknown pilot falls back to `autopilot`; `parallelAt` finer than `handoff` is clamped and logged; `isolation:none` forces `maxWorkers` to 1. `src/core/config.normalizeTiers` migrates `byDifficulty`/`master` from `harness/model-router.json` once, per tier.

**Why.** A hand-edited `config.json` must produce a widget, never an exception that takes the session down. Logging the clamp tells the human what was changed without breaking the run.

---

## 11. The Daemon owns the run; the session becomes a control panel

**Context.** Before 2.7 the run lived in the human's session and its model. The loop pushed the brief back into that session, so the session's model did every task, its context carried the whole run, and handoff replaced the human's terminal.

**Decision.** A detached Daemon (`daemon/index.ts` via `spawn(detached:true)` + `unref()`) owns the run: heartbeat every 20s (stale 90s), localhost server on `127.0.0.1:0` with a 0600 token (`daemon.json`), `supervisor.json` + `activity.json` workers log. The extension captures `ctx.model` to `run.json.baseModel` at arm time; workers run as `pi --mode rpc` children with `--model` from their tier. `src/supervisor.ts` drives them — plain JS, zero tokens in the human session.

**Cost.** One more process; `harness/daemon.log` for diagnostics; `guardSingleOwner` to prevent rival Daemons.

---

## 12. Handoff and model boundary are the same boundary

**Decision.** `session.handoff` names the unit (goal/phase/sprint/feature/task/subtask). One worker owns one unit from start to finish. Crossing a unit boundary closes that worker and starts a new one; because the model is chosen at spawn, the session boundary and the model boundary are the same boundary by construction. A feature-level handoff is one session for the whole feature, and its tasks share that feature's hardest tier.

---

## 13. Per-phase planning invariants

**Decision.** Every phase owns its tasks (`Task.phase` required on write, handoff collapse, progressive expansion via an `A` worker). `decideNext` is phase-scoped; `isPhaseDone` includes the rework queue; `rework` flips `complete` to `pending` with a record (forward-only); `replan` cancels (adds a `replan.json` record) rather than deleting, capped at 3 per phase. Gates hold until rework is drained; rework is capped at 2 and `maxBounces` at 2 with `bounceRequiresDelta`.

---

## 14. Parallel steel: ready-set, worktree, gate, merge

**Decision.** `scheduler.ts` `ready` set respects `phase`/`dependsOn`/`parallelAt`/`maxWorkers`; `daemon/worktree.ts` creates a git worktree per concurrent worker, gates in the worktree, then merges under a merge lock with `post-merge gate` verification. Merge conflicts rework; worktree per worker is `worktree`/`none` isolation. After the worktree path was proven, `maxWorkers` was raised 1 → 3 with an `e2e --only realpi` proof.
