# DEFINE Phase

## Overview
Interview the user, capture intent, and write a bounded PRD. The output is a
short, unambiguous specification that the PLAN phase can decompose into a
feature list.

## When to Use
- Pipeline is at DEFINE phase (first phase after INIT)
- No `specs/prd.md` exists yet
- User needs to define what to build before planning how

## Craft Skills (read before working)
- `harness/skills/grilling.md` — stress-test the spec with relentless questions before committing to it
- `harness/skills/domain-modeling.md` — pin down domain terms in `harness/docs/DOMAIN.md`
- `harness/skills/research.md` — answer blocking factual questions from primary sources

## Process
1. Read `harness/progress.md` and `AGENTS.md` for context
2. Interview the user to surface objectives, constraints, and exclusions
   (follow `harness/skills/grilling.md`; in autopilot, self-grill and record
   the Q&A in the PRD)
3. **If stack is custom/unknown**, fill `stackMeta` in `harness/config.json`:
   - `testCmd`, `lintCmd`, `buildCmd`, `installCmd`, `coverageCmd`, `configFile`, `extensions`
4. **Define project folder structure** — agree on directory layout:
   - `src/` for source, `tests/` for tests, `docs/` for docs, `scripts/` for automation
   - No source files in project root
5. Write `specs/prd.md` — scope, success criteria, non-goals
6. Keep the PRD bounded: no vague verbs ("improve", "enhance")
7. **Negotiate the sprint contract** (the DEFINE gate requires it agreed):
   - `infinity-harness contract propose --scope "..." --criteria "tests pass|feature X works"`
   - `infinity-harness contract review --agreed` (put on the evaluator hat: would
     these criteria really prove the sprint worked?)
8. **Create a feature branch**: `git checkout -b feature/<short-slug>` (the
   gate rejects work on main/master)
9. Run `the infinity_validate tool` to check gates
10. If PASS → `the infinity_advance tool` to advance to PLAN

## Rationalizations to Avoid
| Excuse | Rebuttal |
|--------|----------|
| "The spec is obvious, let's just build" | Without a PRD, scope creeps and features drift |
| "I'll define it as I go" | Ambiguity compounds — define boundaries upfront |

## Red Flags
- PRD longer than 2 pages — scope is too broad
- Vague success criteria ("works well", "fast enough")
- No non-goals section — everything is in scope

## Verification
- [ ] `specs/prd.md` exists with scope, success criteria, non-goals
- [ ] Sprint contract agreed with non-placeholder verification criteria
- [ ] On a feature branch (not main/master)
- [ ] Folder structure agreed and documented
- [ ] `the infinity_validate tool` passes

## Handoff
On gate pass: `the infinity_advance tool` (Planner → continues as Planner for PLAN)
