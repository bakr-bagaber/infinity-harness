# REVIEW Phase

## Overview
Final quality gate before shipping. The Evaluator reviews the complete codebase
against the evaluator rubric, checks documentation, and ensures the branch is
up-to-date with upstream.

## When to Use
- BUILD/VERIFY/SIMPLIFY phases complete
- Ready for final quality review before release

## Craft Skills (read before working)
- `harness/skills/code-review.md` — two-axis review: spec fidelity + standards/smells

## Process
1. Read `harness/progress.md`, `AGENTS.md`, and `harness/evaluator-rubric.md`
2. Run `/infinity:status` to see current state
3. Run the two-axis review from `harness/skills/code-review.md`:
   spec axis (against `specs/prd.md` + sprint contract + acceptance criteria)
   and standards axis (repo conventions + smell baseline). Fix what's real.
4. Review codebase against evaluator rubric (6 dimensions, 0-2 each):
   - Architecture, test coverage, code quality, documentation, performance, security
5. Check documentation: README.md, CHANGELOG.md, architecture docs
6. Ensure branch is up-to-date: `git push` if needed
7. Run `infinity_validate` to check gates
8. If PASS → `infinity_advance` to advance to SHIP

## Rationalizations to Avoid
| Excuse | Rebuttal |
|--------|----------|
| "Build and verify already checked quality" | Review is holistic — catches cross-cutting issues |
| "Documentation can be added post-ship" | Docs shipped late are docs shipped never |
| "The rubric is too strict" | The rubric encodes minimum quality — meet it |

## Red Flags
- Rubric score below 8/12 — quality is marginal
- Missing README, CHANGELOG, or architecture docs
- Branch behind upstream — merge before shipping

## Verification
- [ ] Evaluator rubric score >= 8/12
- [ ] README.md, CHANGELOG.md exist and are current
- [ ] Branch up-to-date with upstream
- [ ] `infinity_validate` passes

## Handoff
On gate pass: `infinity_advance` (Evaluator → Generator for SHIP)
