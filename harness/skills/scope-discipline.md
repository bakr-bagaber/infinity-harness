---
name: scope-discipline
description: The contract is the boundary — park ideas, resist drive-by fixes, renegotiate explicitly
tags: [meta, scope, creep, contract, focus, discipline, playbook]
when: mid-task ideas, adjacent problems, or "while I'm here" temptations appear
phases: []
kind: process
provenance: { origin: built-in, notes: frontier-playbook }
---

# Scope Discipline

Scope creep is how good sessions produce unshippable diffs. The sprint
contract and the task's acceptance criteria define what you're building —
everything else, however good, is NOT NOW.

## Rules

- **The criteria are the whole job.** Done = criteria met. Not "criteria
  met plus improvements I noticed". Extra behavior nobody asked for is
  scope creep even when it's good — it widens the diff, the review
  surface, and the blast radius.
- **Park, don't pursue.** Mid-task ideas go to the parking lot in one
  line — `harness/lessons-decisions.md "idea: ..."` or a backlog entry in the
  feature list — and you return to the slice. Parking takes 10 seconds;
  pursuing takes an hour and derails the task.
- **Drive-by fixes are parked too.** Broken thing found outside the task
  (unless it BLOCKS the task): record it, leave it. One task = one
  concern = one reviewable diff.
- **Blockers interrupt; everything else waits.** The only legitimate
  mid-task detour is something the acceptance criteria cannot be met
  without. Name it as a blocker (learn), fix the minimum, return.
- **Renegotiate explicitly, never silently.** If the task turns out
  wrong-sized or the contract missed something real: stop, record it, and
  change the plan through the front door (feature-list edit in PLAN
  terms, or contract re-negotiation) — not by quietly building something
  different from what the contract says.
- **Simplification has its phase.** Refactoring urges during BUILD get
  parked for SIMPLIFY — the pipeline gives cleanup its own budgeted slot.

## The test

Before touching a file, ask: *which acceptance criterion needs this
change?* No answer → you're creeping. Park it.

## Checklist

- [ ] Diff touches only what the criteria require
- [ ] Every parked idea captured (learn/backlog), none pursued
- [ ] Any scope change went through plan/contract, with a decision recorded
