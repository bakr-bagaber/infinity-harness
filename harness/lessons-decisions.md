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



### 2026-08-29 — V3 Daemon: the run must survive the session
**Lesson:** `let loopEnabled` died with the pi session that held it; the first handoff ended the run. Every `spawn` inside `decideNext` left litter and an unawaited promise. `ctx.setModel` on the live session could never route a per-task model because a session has one model.
**Decision:** Run state in `harness/run.json` + `daemon.json` on disk; work in `pi --mode rpc` children (one per unit, `--model` from tier); session boundary = model boundary; `createIsolatedLoader` (noExtensions/noSkills) + `customTools` injection; `supervisor.json`/`activity.json` are what the widget/dashboard read.
**Recorded:** 2026-08-29T23:21:00.000Z

### 2026-08-29 — Plan canonicalisation
**Lesson:** `harness/features/feature-list.json` leaked storage layout into every module and the ARCHITECTURE diagram; callers mixed the two paths and drifted.
**Decision:** Canonical is `harness/plan.json`; legacy is read-through + write-through alias via `src/core/featureList.resolvePlanFile`/`loadFeatureList`/`saveFeatureList` and `src/core/plan.ts` shim. One implementation.
**Recorded:** 2026-08-29T23:21:00.000Z

### 2026-08-29 — Windows path portability
**Lesson:** 5 test suites failed on Windows because path joins produced backslashes (`tmpinfinity-harness`) while tests asserted forward slashes, `echo '...'` is not valid `cmd.exe` syntax, and `path.slice(length+1)` assumed forward slash.
**Decision:** Normalise with `.replace(/\/g,"/")` on every user-visible path, use `path.relative` or `node -e "console.log(...)"` for shell snippets, and assert via normalised includes (`replace(/\/g,"/").includes("tmp/infinity-harness")`).
**Recorded:** 2026-08-29T23:22:00.000Z
