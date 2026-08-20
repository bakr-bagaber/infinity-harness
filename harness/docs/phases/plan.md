# PLAN Phase

## Overview
Decompose the PRD into a feature list with bounded tasks. Each feature becomes
a unit of work that BUILD can implement and VERIFY can validate independently.

## When to Use
- DEFINE phase complete (PRD exists)
- Need to break PRD into implementable features and tasks

## Craft Skills (read before working)
- `harness/skills/planning-tasks.md` — tracer-bullet vertical slices + the feature-list format
- `harness/skills/codebase-design.md` — shape features around deep modules with small interfaces

## Process
1. Read `harness/progress.md`, `AGENTS.md`, and `specs/prd.md`
2. Decompose the PRD into features — each a **vertical slice** that is
   demoable on its own (see `harness/skills/planning-tasks.md`)
3. For each feature, define tasks — each a single, testable change sized to
   one working session
4. Write `harness/features/feature-list.json`. Every task needs
   `acceptanceCriteria` (1–3 concrete, checkable statements); every feature
   needs `definitionOfDone` (user-visible outcomes). Gates reject
   placeholders.
5. Commit the plan (`git commit -am "plan: feature list"`)
6. Run `dev-harness validate` to check gates
7. If PASS → `dev-harness phase next` to advance to BUILD

> The sprint contract was agreed in DEFINE. If PLAN reveals the scope was
> wrong, renegotiate it now (`contract propose` → `contract review`) — not
> silently during BUILD.

## Rationalizations to Avoid
| Excuse | Rebuttal |
|--------|----------|
| "Tasks are obvious from the PRD" | Undecomposed tasks lead to incomplete implementations |
| "I'll plan during build" | Context switching kills momentum — plan first |

## Red Flags
- Features with more than 7 tasks — too coarse, decompose further
- Tasks with vague descriptions ("handle edge cases") — specify what
- No sprint contract — no agreement on scope

## Verification
- [ ] `feature-list.json` exists with features and tasks
- [ ] Sprint contract proposed and agreed
- [ ] `dev-harness validate` passes

## Handoff
On gate pass: `dev-harness phase next` (Planner → Generator for BUILD)
