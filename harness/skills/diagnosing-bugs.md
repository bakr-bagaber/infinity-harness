---
name: diagnosing-bugs
description: Feedback-loop-first debugging discipline for hard bugs and regressions
tags: [debug, debugging, bug, error, failure, crash, flaky, slow, performance, regression, bisect]
when: something is broken, throwing, failing intermittently, or slow
phases: [verify, build]
provenance: { origin: "mattpocock/skills", license: MIT, adapted: true }
---

# Diagnosing Bugs

> Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT © Matt Pocock).
> Use during: VERIFY, or any time something is broken, throwing, failing, or slow.

A discipline for hard bugs. Follow the phases in order; skip one only when
you can explicitly justify it.

## Phase 1 — Build a feedback loop

**This is the skill.** Everything else is mechanical. You need a **tight**
pass/fail signal that goes red on *this* bug. Without one, no amount of
staring at code will save you. Spend disproportionate effort here.

Ways to construct one, roughly in order:

1. **Failing test** at whatever seam reaches the bug — unit, integration, e2e.
2. **CLI/HTTP invocation** with a fixture input, diffing output against a known-good result.
3. **Replay a captured trace** — save a real payload/event log, replay it through the code path in isolation.
4. **Throwaway harness** — a minimal subset of the system (one module, mocked externals) that exercises the bug path with a single call.
5. **Bisection harness** — if the bug appeared between two known states, automate "boot at state X, check" so `git bisect run` can do the work.
6. **Differential loop** — run the same input through old vs new version and diff outputs.

Once you have *a* loop, **tighten** it: faster (seconds, not minutes),
sharper (assert the exact symptom, not "didn't crash"), deterministic (pin
time, seed RNG, isolate filesystem). For flaky bugs, raise the reproduction
rate — loop the trigger 100×, add stress, narrow timing — until it's
debuggable.

**Completion criterion:** you can name ONE command you have already run that
is red-capable (asserts the user's exact symptom), deterministic, fast, and
runnable unattended. If you catch yourself reading code to build a theory
before this command exists — stop. That's the exact failure this skill
prevents.

## Phase 2 — Reproduce + minimise

Run the loop. Watch it go red. Confirm it produces the failure mode that was
*reported* — not a different failure nearby. Then shrink the repro to the
smallest scenario that still goes red: cut inputs, callers, config, one at a
time, re-running after each cut. Done when every remaining element is
load-bearing.

## Phase 3 — Hypothesise

Generate **3–5 ranked hypotheses** before testing any. Each must be
falsifiable: "If X is the cause, then changing Y will make the bug
disappear." If you can't state the prediction, it's a vibe — discard it.
Record the ranked list (in the task notes or `harness/lessons-decisions.md`).

## Phase 4 — Instrument

Each probe maps to one prediction. Change one variable at a time. Prefer a
debugger/REPL breakpoint over logs; targeted logs over log-everything. Tag
every debug log with a unique prefix (e.g. `[DEBUG-a4f2]`) so cleanup is a
single grep. For performance bugs: measure a baseline first, then bisect —
logs are usually the wrong tool.

## Phase 5 — Fix + regression test

Write the regression test **before the fix** — at a seam that exercises the
real bug pattern. If no correct seam exists, that is itself a finding:
record it as a lesson. Then: watch the test fail → apply the fix → watch it
pass → re-run the Phase 1 loop against the original scenario.

## Phase 6 — Cleanup + post-mortem

- [ ] Original repro no longer reproduces
- [ ] Regression test passes (or absence of seam documented)
- [ ] All `[DEBUG-...]` instrumentation removed (grep the prefix)
- [ ] Throwaway harnesses deleted
- [ ] Record the confirmed hypothesis: `harness/lessons-decisions.md "bug X was caused by Y"`

Then ask: what would have prevented this bug? If the answer is architectural
(no test seam, tangled callers), record it: `infinity-harness decision "..."`.
