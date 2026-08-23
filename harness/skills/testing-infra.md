---
name: testing-infra
description: Test infrastructure — fixtures, isolation, flaky-test policy, CI hygiene, coverage sanity
tags: [test, testing, fixture, ci, flaky, coverage, mock, isolation, pipeline, suite]
when: task sets up test tooling, fixtures, CI, or fights slow/flaky suites
phases: [build, verify]
kind: domain
provenance: { origin: built-in }
---

# Testing Infrastructure

(`tdd.md` covers what a good test IS; this covers the machinery around them.)

## Rules

- **Tests are order-independent and parallel-safe.** Each test creates its
  own data and cleans up (or runs in a transaction rolled back / fresh
  tmpdir). If running one test alone changes its result, the suite is
  broken even while green.
- **Fixtures are builders, not blobs.** `makeUser({overrides})` beats a
  500-line fixtures.json — tests state only what matters, defaults carry
  the rest, schema changes touch one builder.
- **Determinism is manufactured:** pin the clock (fake timers), seed RNG,
  freeze network (record/replay or fakes at the seam), isolate filesystem
  (tmpdir per test). Anything you didn't pin will flake at 2am.
- **Flaky-test policy — zero tolerance:** a flaky test is a P1 against the
  suite. Quarantine it the day it flakes (skip with a linked issue),
  diagnose with `diagnosing-bugs.md` (usually: unpinned time, shared
  state, real network, race). A retried-until-green suite verifies nothing.
- **The pyramid is a budget:** many fast unit/integration tests at seams,
  few end-to-end smoke tests. E2E for "the wiring works", not for every
  edge case — edges belong at the seam where they live.
- **CI runs what developers run:** same command (`npm test`), same
  versions, fresh checkout, no network by default. "Works locally" bugs
  are environment drift — fix the environment, not the test.
- **Coverage is a smoke detector, not a target.** Use it to FIND untested
  branches; never write assertion-free tests to move the number. The
  gate's threshold is a floor, not a goal.

## Anti-patterns

- **Shared mutable fixtures** ("the test database user") → per-test data
  with unique keys; suites die by a thousand shared rows.
- **Sleeping to wait** (`sleep 2` then assert) → poll with timeout or
  await the actual signal; sleeps are both slow AND flaky.
- **Mocking the world** — suite passes while the app is down → integration
  tests at real seams (real DB, real HTTP server in-process).
- **Snapshot everything** — giant snapshots nobody reads, updated with
  `--update` reflexively → snapshot small, stable, reviewed outputs only.

## Checklist

- [ ] Any single test runs alone: same result
- [ ] Suite passes twice in a row AND with a different order/seed
- [ ] No real network/clock/RNG unpinned anywhere
- [ ] Flaky tests quarantined with linked issues (count: 0 is the goal)
- [ ] CI command identical to the local test command
