# VERIFY Phase

## Overview
Independently verify that built features meet acceptance criteria. The Evaluator
role runs tests, checks coverage, and validates behavior against the PRD.

## When to Use
- BUILD phase complete (all features pass)
- Need to verify quality before review

## Craft Skills (read before working)
- `harness/skills/diagnosing-bugs.md` — build a feedback loop BEFORE hypothesizing about any failure
- `harness/skills/tdd.md` — regression tests for anything you fix

## Process
1. Read `harness/progress.md`, `AGENTS.md`, and `specs/prd.md`
2. Run `the infinity_brief tool` to see the current verification step
3. For each feature:
   a. Run the test suite: `npm test`
   b. Check coverage: `{{coverageCmd}}` (if coverage gate enabled)
   c. Verify behavior matches acceptance criteria from PRD
   d. Run `the infinity_validate tool --feature <id> --task <id>` per task
4. If any task fails → fix and re-validate (retry)
5. When all features verified → run `the infinity_validate tool` (full phase)
6. If PASS → `the infinity_advance tool` to advance to SIMPLIFY or REVIEW

## Rationalizations to Avoid
| Excuse | Rebuttal |
|--------|----------|
| "Build already validated, no need to re-verify" | Build validates implementation; VERIFY validates behavior |
| "Coverage is high enough" | Check against configured threshold, not gut feeling |
| "Edge cases are unlikely" | Unlikely ≠ impossible — test them |

## Red Flags
- Tests pass but behavior doesn't match PRD acceptance criteria
- Coverage below configured threshold
- Missing tests for error/edge cases

## Verification
- [ ] All tests pass: `npm test`
- [ ] Coverage meets threshold (if gate enabled)
- [ ] Behavior matches PRD acceptance criteria
- [ ] `the infinity_validate tool` passes

## Handoff
On gate pass: `the infinity_advance tool` (Evaluator → Simplifier for SIMPLIFY, or Evaluator for REVIEW)
