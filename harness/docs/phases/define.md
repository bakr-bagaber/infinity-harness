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
7. **Write the acceptance criteria into the plan** — this is what the DEFINE
   gate actually checks. Every feature needs criteria before it opens:

   ```jsonc
   // infinity_plan
   {
     "goal": "one line: what this whole run is for",
     "features": [
       { "id": "feature-001", "name": "Checkout flow",
         "criteria": ["refunds reconcile against the ledger"] }
     ]
   }
   ```

   Tasks are a separate list and arrive in PLAN — do not nest them here.
   Criteria must be observable: "refunds reconcile against the ledger", not
   "refunds work well". Put the evaluator hat on and ask whether passing these
   would really prove the feature works.
8. **Record the sprint contract** in `harness/sprint-contract.md` — scope,
   what is explicitly out, and how you will know you are done. The gate does
   not read it; the next session does.
9. **Create a feature branch**: `git checkout -b feature/<short-slug>` (later
   gates reject work on main/master)
10. Run `infinity_validate` to check gates
11. If PASS → `infinity_advance` to advance to PLAN

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
- [ ] Every feature has observable acceptance criteria in the plan
- [ ] Sprint contract recorded in `harness/sprint-contract.md`
- [ ] On a feature branch (not main/master)
- [ ] Folder structure agreed and documented
- [ ] `infinity_validate` passes

## Handoff
On gate pass: `infinity_advance` (Planner → continues as Planner for PLAN)
