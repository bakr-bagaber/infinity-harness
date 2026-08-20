---
name: codebase-design
description: Deep modules — small interfaces hiding lots of behavior, seams, testability
tags: [design, architecture, module, interface, seam, refactor, coupling, abstraction, api]
when: designing module boundaries, planning features, refactoring for clarity
phases: [plan, simplify]
provenance: { origin: "mattpocock/skills", license: MIT, adapted: true }
---

# Codebase Design — Deep Modules

> Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT © Matt Pocock).
> Use during: PLAN (shaping features into modules) and SIMPLIFY (finding deepening opportunities).

Design **deep modules**: a lot of behaviour behind a small interface, placed
at a clean seam, testable through that interface.

## Vocabulary (use these terms exactly)

- **Module** — anything with an interface and an implementation: a function,
  class, package, or tier-spanning slice. (Avoid: unit, component, service.)
- **Interface** — everything a caller must know to use the module correctly:
  the signature, plus invariants, ordering constraints, error modes, config,
  performance characteristics. (Avoid: API — too narrow.)
- **Seam** — a place where you can alter behaviour without editing in that
  place; where a module's interface lives. (Avoid: boundary.)
- **Adapter** — a concrete thing that satisfies an interface at a seam.
- **Depth** — leverage at the interface: how much behaviour a caller (or
  test) can exercise per unit of interface they must learn.

## Deep vs shallow

```
Deep (aim for this):          Shallow (avoid):
┌───────────────┐             ┌───────────────────────────────┐
│ Small interface│            │        Large interface        │
├───────────────┤             ├───────────────────────────────┤
│               │             │      Thin implementation      │
│  Deep impl    │             └───────────────────────────────┘
│               │
└───────────────┘
```

When designing an interface, ask: Can I reduce the number of methods? Can I
simplify the parameters? Can I hide more complexity inside?

## Principles

- **Depth is a property of the interface, not the implementation.** A deep
  module can be internally composed of small parts — they just aren't part
  of the interface.
- **The deletion test.** Imagine deleting the module. If complexity
  vanishes, it was a pass-through. If complexity reappears across N callers,
  it was earning its keep.
- **The interface is the test surface.** Callers and tests cross the same
  seam. If you want to test *past* the interface, the module is probably
  the wrong shape.
- **One adapter means a hypothetical seam. Two adapters means a real one.**
  Don't introduce a seam unless something actually varies across it.

## Designing for testability

1. **Accept dependencies, don't create them.**
   `processOrder(order, paymentGateway)` — testable.
   `processOrder(order)` that news up `StripeGateway()` inside — not.
2. **Return results, don't produce side effects.**
   `calculateDiscount(cart): Discount` — testable.
   `applyDiscount(cart): void` that mutates — harder.
3. **Small surface area.** Fewer methods = fewer tests needed. Fewer params
   = simpler test setup.
