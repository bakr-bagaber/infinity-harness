# Evaluator rubric

The REVIEW phase scores the work against these six dimensions, two points each. The gate opens at 8;
below that, the phase repeats. Score it as if someone else wrote the code.

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| **Correctness** | Known defects, or claims not backed by a passing gate | Works on the happy path; edge cases untested | Behaviour proven by tests that would fail if the code regressed |
| **Simplicity** | Duplicated logic, dead paths, speculative abstraction | Reasonable, with some redundancy | Nothing left to remove without losing something real |
| **Robustness** | Crashes or corrupts state on bad input | Handles the obvious failures | Bounded, atomic, and recoverable — survives a crash mid-write |
| **Clarity** | Reader must run it to understand it | Readable; comments restate the code | Comments explain *why*; the *what* is evident from the code |
| **Test quality** | No tests, or tests that assert the implementation | Covers the main paths | Covers the contract, including adversarial input, and fails loudly |
| **Handoff readiness** | Next person starts from scratch | Docs exist but are stale | README, architecture and decisions all match the code as it is |

## Scoring notes

- **Do not score your own confidence.** Score the evidence. "I believe this works" is a 0 for
  correctness; a passing gate over a test that would catch the regression is a 2.
- **A dimension at 0 is a blocker regardless of the total.** An eight-point score with a zero in
  robustness is not a pass — record it and repeat the phase.
- **Cite what you checked.** A score without a file, a test name or a command is not a review.

## Record

Append each review below: date, commit, per-dimension score with evidence, and the decision.
