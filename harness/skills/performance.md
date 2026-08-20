---
name: performance
description: Performance work — measure first, fix the biggest cost, cache with invalidation, verify
tags: [performance, slow, latency, profiling, optimize, cache, memory, benchmark, throughput, speed]
when: something is slow, memory-hungry, or a task sets performance targets
phases: [verify, build]
provenance: { origin: built-in }
---

# Performance

## Rules

- **Measure before touching anything.** Reproduce the slowness with a
  number (timing harness, profiler, EXPLAIN, flamegraph) and save the
  baseline. Optimizing without a measurement is guessing — most guesses
  about "the slow part" are wrong.
- **Fix costs in order of size.** The profile ranks them. The top item is
  usually I/O shaped: N+1 queries, missing index, sync call in a loop,
  chatty API — algorithmic elegance rarely matters before those are gone.
- **Set a target before optimizing** ("p95 < 300ms", "fits in 512MB").
  Without a target, optimization never ends; with one, you stop on hit.
- **Do less work first:** don't compute what nobody reads, paginate,
  filter at the source (DB, not app), batch round-trips, stream instead of
  buffering whole payloads.
- **Cache only with an invalidation story.** Every cache states: key,
  TTL/eviction, and what makes it stale. A cache without invalidation is a
  correctness bug on a delay. Prefer short TTLs you can reason about.
- **Verify with the same harness** that produced the baseline; keep the
  before/after numbers in the commit message. No number = no optimization
  happened.
- **Concurrency ≠ speed.** Parallelizing CPU-bound work on one core, or
  hammering a saturated DB harder, makes it slower. Know which resource is
  the bottleneck first.

## Anti-patterns

- **Micro-optimizing the cold path** — shaving the loop while every call
  does a network round-trip → profile decides, not intuition.
- **Speculative caching layers** — Redis before there's a measured need →
  measure, then cache the specific hot read.
- **Load testing at 1×** — perf verified only at dev-scale → test at
  expected load ± spike; N+1s hide at N=3.
- **"It's the language/framework"** — usually it's your query pattern.
  Prove the platform is the ceiling before replatforming.

## Checklist

- [ ] Baseline measured and saved before any change
- [ ] Target stated; work stops when hit
- [ ] Top profile item addressed first (linked evidence)
- [ ] Every cache has key/TTL/invalidation written down
- [ ] After-numbers from the same harness, in the commit
