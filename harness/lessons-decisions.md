# Lessons & Decisions

> Append-only log. Each lesson is paired with its decision.

### 2026-08-21
**Decision:** use toolResult.details {rev,tasks} + hidden harness:checkpoint custom injection via context event for compaction survival; branch-aware replay scans session branch for latest valid entry
**Addresses lesson:** task-003: global dev-harness-cli ralph-shared lacked 5-level preservation; local fix not used by validate, caused baseRevision stripping — copied fixed file to global node_modules
**Recorded:** 2026-08-21T00:28:18.425Z

### 2026-08-21
**Decision:** Duplicate src logic in extension for Pi runtime isolation (accepted 2026-08-21) — keeps enforcer self-contained without build step; debt to bundle src/shared via tsup in F2
**Addresses lesson:** REVIEW: extension duplicates src widget + atomic logic for runtime isolation — intentionally not DRY; bundle deferred to F2 via tsup; documented as trade-off in ARCHITECTURE.md/DECISIONS.md
**Recorded:** 2026-08-21T00:43:02.386Z

