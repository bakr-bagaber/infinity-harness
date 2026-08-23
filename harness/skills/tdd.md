---
name: tdd
description: Red → green test-driven loop — what a good test is, seams, anti-patterns
tags: [tdd, test, testing, unit, integration, red-green, seam, mock, coverage]
when: implementing any BUILD task, or fixing a bug that needs a regression test
phases: [build, verify]
kind: process
provenance: { origin: "mattpocock/skills", license: MIT, adapted: true }
---

# TDD — Test-Driven Development

> Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT © Matt Pocock).
> Use during: BUILD (every task).

TDD is the red → green loop. This skill makes that loop produce tests worth
keeping. Every section applies on every cycle.

Before exploring the codebase, read `harness/docs/DOMAIN.md` (if present) so
test names and interface vocabulary match the project's domain language, and
respect decisions recorded in `harness/docs/DECISIONS.md`.

## Rules of the loop

- **Red before green.** Write the failing test first, then only enough code
  to pass it. Don't anticipate future tests or add speculative features.
- **One slice at a time.** One seam, one test, one minimal implementation
  per cycle.
- **Refactoring is not part of the loop.** It belongs to SIMPLIFY/REVIEW,
  not the red → green cycle.

## What a good test is

Tests verify behavior through public interfaces, not implementation details.
Code can change entirely; tests shouldn't. A good test reads like a
specification — "user can checkout with valid cart" tells you exactly what
capability exists — and survives refactors because it doesn't care about
internal structure.

```js
// GOOD: observable behavior through the public API
test('user can checkout with valid cart', async () => {
  const cart = createCart();
  cart.add(product);
  const result = await checkout(cart, paymentMethod);
  expect(result.status).toBe('confirmed');
});

// BAD: implementation detail — breaks on refactor, catches nothing real
test('checkout calls paymentService.process', async () => {
  const mockPayment = mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});
```

## Seams — where tests go

A **seam** is the public boundary you test at: the interface where you
observe behavior without reaching inside. Tests live at seams, never against
internals. Before writing any test, write down the seams under test — the
task's acceptance criteria usually name them. Testing effort goes to critical
paths and complex logic, not every edge case.

Mock **only at external seams** (network, clock, filesystem, third-party
APIs) — never mock your own internal collaborators.

## Anti-patterns

- **Implementation-coupled** — mocks internal collaborators, tests private
  methods, or verifies through a side channel (querying the database instead
  of using the interface). Tell: the test breaks when you refactor but
  behavior hasn't changed.
- **Tautological** — the assertion recomputes the expected value the way the
  code does (`expect(add(a, b)).toBe(a + b)`), so it passes by construction.
  Expected values must come from an independent source of truth — a
  known-good literal, a worked example, the spec.
- **Horizontal slicing** — writing all tests first, then all implementation.
  Bulk tests verify *imagined* behavior. Work in **vertical slices**: one
  test → one implementation → repeat, each test a tracer bullet that responds
  to what the last cycle taught you.
