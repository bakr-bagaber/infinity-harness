# BUILD Phase

## Overview
Implement each feature task-by-task. The task loop iterates features and tasks,
producing instructions for each. Validate after each task before advancing.

## When to Use
- PLAN phase complete (feature list + sprint contract exist)
- Ready to write code

## Craft Skills (read before working)
- `harness/skills/tdd.md` — red → green loop; what makes a test worth keeping
- `harness/skills/prototype.md` — when a design question can't be answered on paper
- `harness/skills/diagnosing-bugs.md` — when something breaks mid-build

## Process
1. Read `harness/progress.md`, `AGENTS.md`, and `harness/features/feature-list.json`
2. Run `the infinity_brief tool` to get the current task brief (feature, task, criteria)
3. For each incomplete feature → for each pending task:
   a. Implement the task **test-first** (see `harness/skills/tdd.md`): failing
      test → minimal code to pass → next slice
   b. Run `the infinity_validate tool --feature <id> --task <id>` to validate
   c. If PASS → task marked complete, advance to next task
   d. If FAIL → fix issues, re-validate (retry up to `retry.tasks.maxRetries`)
4. When all tasks in a feature pass → feature marked complete
5. When all features pass → phase gate passes
6. Run `the infinity_advance tool` to advance to VERIFY

## Rationalizations to Avoid
| Excuse | Rebuttal |
|--------|----------|
| "I'll validate at the end" | Late validation catches problems when they're expensive to fix |
| "This task is trivial, skip validation" | Trivial tasks still have edge cases |
| "The tests pass, so it works" | Tests must cover acceptance criteria, not just happy path |

## Red Flags
- Tasks marked complete without validation
- Features with all tasks complete but `passes: false` — run validate
- Tests that only test the implementation, not the behavior

## Verification
- [ ] Each task validated with `the infinity_validate tool --feature X --task Y`
- [ ] All features marked `passes: true` in feature-list.json
- [ ] `the infinity_validate tool` passes (full phase gates)

## Handoff
On gate pass: `the infinity_advance tool` (Generator → Evaluator for VERIFY)
