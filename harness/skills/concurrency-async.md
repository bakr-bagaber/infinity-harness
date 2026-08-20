---
name: concurrency-async
description: Concurrency and async correctness — races, idempotency, queues, cancellation, locking
tags: [concurrency, async, race, parallel, queue, lock, mutex, retry, idempotent, worker, thread, promise, deadlock, atomic]
when: task involves parallel work, background jobs, shared state, or retried operations
phases: [plan, build, verify]
provenance: { origin: built-in }
---

# Concurrency & Async

## Rules

- **Name the shared state.** Before writing concurrent code, list what is
  read/written by more than one flow. No list = you haven't designed yet.
  Prefer eliminating sharing (message passing, ownership) over locking it.
- **Check-then-act is a race.** `if (!exists) create()` fails under
  concurrency every time. Push atomicity down: unique constraints +
  upsert, atomic compare-and-swap, `INSERT ... ON CONFLICT` — let the
  storage layer arbitrate.
- **Everything retried must be idempotent.** Queues deliver at-least-once;
  networks retry; users double-click. Design handlers so processing twice
  = processing once (idempotency keys, natural dedup, upserts).
- **Every await is a suspension point.** State can change across it —
  re-validate assumptions after resuming; don't cache a check made before
  an await and act on it after.
- **Bound everything:** every queue has a max depth + backpressure
  behavior; every parallel map has a concurrency limit; every wait has a
  timeout. Unbounded = OOM or thundering herd, only later.
- **Cancellation propagates.** Long operations accept a signal
  (AbortSignal / context) and pass it to their children; on cancel, clean
  up partial work.
- **One lock order.** If you must hold two locks, EVERY path acquires them
  in the same documented order — that single rule prevents most deadlocks.

## Anti-patterns

- **Fire-and-forget promises** — unawaited async work whose failures
  vanish → await it, or hand it to a supervised job runner that logs +
  retries.
- **Sleep-based coordination** — "wait 500ms so X finishes first" →
  synchronize on the event itself; timing assumptions break under load.
- **Global mutable singletons as coordination** → explicit passing or a
  real store with atomic ops.
- **Distributed transactions by hope** — two systems updated without an
  outbox/saga → write locally + outbox table, deliver async, reconcile.

## Testing concurrency

Force interleavings — don't hope: run the racy pair with a barrier so both
start together; loop 100×; inject delays at suspension points. A race you
can't provoke deliberately is a race you'll meet in production
(`diagnosing-bugs.md` § non-deterministic bugs).

## Checklist

- [ ] Shared state enumerated; each entry owned, locked, or made atomic
- [ ] All retried paths provably idempotent (test: run handler twice)
- [ ] Queues/parallelism/waits all bounded with explicit numbers
- [ ] Cancellation reaches children; partial work cleaned up
- [ ] At least one test forces the race window
