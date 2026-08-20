# SIMPLIFY Phase

## Overview
Reduce code complexity without changing behavior. Remove dead code, consolidate
duplicates, flatten deep nesting, and ensure tests still pass after changes.

## When to Use
- VERIFY phase complete (optional phase — only if enabled in config)
- Code works but has accumulated complexity during build

## Craft Skills (read before working)
- `harness/skills/codebase-design.md` — deepen modules: more behavior behind smaller interfaces
- `harness/skills/code-review.md` — the smell baseline (what to hunt for)

## Process
1. Read `harness/progress.md` and `AGENTS.md`
2. Run `dev-harness next` to see the current step
3. For each feature:
   a. Review code for: code smells, deep nesting, DRY violations, dead code
   b. Simplify: consolidate duplicate logic, flatten conditionals, remove unused
   c. Run `npm test` to ensure tests still pass after simplification
   d. Run `dev-harness validate --feature <id> --task <id>` per task
4. When all features simplified → run `dev-harness validate` (full phase)
5. If PASS → `dev-harness phase next` to advance to REVIEW

## Rationalizations to Avoid
| Excuse | Rebuttal |
|--------|----------|
| "It works, don't touch it" | Working code with high complexity is a liability |
| "Simplification risks breaking things" | Tests catch breakage — that's what they're for |
| "I'll clean up later" | Later never comes — simplify now while context is fresh |

## Red Flags
- Tests fail after simplification — you changed behavior, not just structure
- Simplification removed more than 20% of code — may have removed needed logic
- No tests to verify behavior preserved — add tests before simplifying

## Verification
- [ ] Code smells reduced (subjective — use judgment)
- [ ] No new dead code introduced
- [ ] Tests still pass: `npm test`
- [ ] `dev-harness validate` passes

## Handoff
On gate pass: `dev-harness phase next` (Simplifier → Evaluator for REVIEW)
