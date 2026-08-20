---
name: prototype
description: Throwaway code that answers a design question fast, then gets deleted
tags: [prototype, spike, experiment, explore, poc, throwaway, design]
when: a state model, logic shape, or UI direction cannot be judged on paper
phases: [build, plan]
provenance: { origin: "mattpocock/skills", license: MIT, adapted: true }
---

# Prototype

> Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT © Matt Pocock).
> Use during: BUILD (or PLAN) when a design question can't be answered on paper.

A prototype is **throwaway code that answers a question**. The question
decides the shape:

- **"Does this logic / state model feel right?"** → build a tiny runnable
  script that pushes the state machine through the cases that are hard to
  reason about on paper.
- **"What should this look like?"** → build several radically different
  variations of the interface, cheaply switchable.

## Rules

1. **Throwaway from day one, clearly marked.** Name it so a casual reader
   sees it's a prototype (`proto-*`, a `prototypes/` dir) — never mixed
   into production paths.
2. **One command to run.** Whatever the project's runner supports.
3. **No persistence by default.** State lives in memory; persistence is
   usually the thing being *checked*, not a dependency.
4. **Skip the polish.** No tests, no error handling beyond runnability, no
   abstractions. The point is to learn fast.
5. **Surface the state.** After every action, print the full relevant state
   so the effect of each step is visible.
6. **Capture it when done.** Fold the validated decision into the real code
   and record it: `dev-harness decision "state machine X chosen because Y
   (validated by prototype)"`. Then DELETE the prototype — the
   anti-placeholder gate will flag leftovers, and that's by design.
