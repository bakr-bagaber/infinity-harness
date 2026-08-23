---
name: code-review
description: Two-axis review (spec fidelity + standards/smells) with the Fowler smell baseline
tags: [review, quality, smell, refactor, standards, spec, diff, audit]
when: reviewing a diff, a branch, or the whole delivery before shipping
phases: [review, simplify]
provenance: { origin: "mattpocock/skills", license: MIT, adapted: true }
---

# Code Review — Two Axes

> Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT © Matt Pocock).
> Use during: REVIEW (whole-delivery review) and when reviewing any diff.

Review the diff since a fixed point along two independent axes. Never merge
them — a change can pass one and fail the other, and one axis must not mask
the other.

- **Spec axis** — does the code faithfully implement what was asked?
- **Standards axis** — does the code follow this repo's conventions and
  avoid the smell baseline below?

## Process

1. **Pin the fixed point.** `git diff <fixed-point>...HEAD` (three-dot) and
   `git log <fixed-point>..HEAD --oneline`. In the harness pipeline the fixed
   point is usually the phase-start or sprint-start commit/tag
   (`infinity-harness rollback list` shows checkpoints).
2. **Spec review.** The spec sources are `specs/prd.md`, the sprint contract
   (`harness/sprint-contract.md`), and the feature list's acceptance
   criteria. Report: (a) requirements missing or partial; (b) behaviour
   nobody asked for (scope creep); (c) requirements that look implemented
   but wrong. Quote the spec line for each finding.
3. **Standards review.** Sources: the repo's documented conventions
   (CONTRIBUTING, lint config, `harness/docs/CONSTRAINTS.md`) plus the smell
   baseline below. Documented repo standards override the baseline; skip
   anything tooling already enforces. Smells are judgement calls — label
   them, don't treat them as violations.
4. **Report both axes separately**, then fix what's real. Fill in
   `harness/evaluator-rubric.md` with evidence, not vibes.

## Smell baseline (Fowler, Refactoring ch. 3)

Each reads *what it is* → *how to fix*:

- **Mysterious Name** — name doesn't reveal what it does/holds → rename; if no honest name comes, the design is murky.
- **Duplicated Code** — same logic shape in more than one place → extract the shared shape.
- **Feature Envy** — a method reaches into another object's data more than its own → move it onto the data it envies.
- **Data Clumps** — the same few fields/params keep travelling together → bundle into one type.
- **Primitive Obsession** — a primitive standing in for a domain concept → give the concept its own type.
- **Repeated Switches** — same switch/if-cascade recurs → polymorphism or one shared map.
- **Shotgun Surgery** — one logical change forces scattered edits everywhere → gather into one module.
- **Divergent Change** — one module edited for several unrelated reasons → split it.
- **Speculative Generality** — abstraction for needs the spec doesn't have → delete it.
- **Message Chains** — long `a.b().c().d()` navigation → hide the walk behind one method.
- **Middle Man** — a thing that mostly delegates onward → cut it.
- **Refused Bequest** — an implementer ignoring most of what it inherits → composition over inheritance.
