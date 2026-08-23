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
