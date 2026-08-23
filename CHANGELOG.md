# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] — 2026-08-23

Renamed from `pi-harness` to **infinity-harness**, and rebuilt from a working prototype into
something shippable. This is a breaking release: tool names, command names and the package name all
changed, and the extension no longer depends on an external repository.

### Breaking

- **Package renamed** `pi-harness` → `infinity-harness`.
- **Tools renamed.** `harness_task_list` → `infinity_plan`, `pi_goal_task`/`harness_goal_loop` →
  `infinity_goal`, `pi_harness_remote`/`harness_remote` → `infinity_dashboard`,
  `harness_spawn_worker` → `infinity_spawn_worker`. New: `infinity_brief`, `infinity_validate`,
  `infinity_advance`.
- **Commands renamed** to the `/infinity:*` namespace, and `/infinity:run` / `/infinity:halt` added.
- **The `cli`, `prompts` and `skills` symlinks are gone.** They pointed at absolute paths inside a
  sibling `dev-harness` checkout, which made the package impossible to install anywhere else. The
  logic they reached is now owned TypeScript in `src/core/`. Skills ship from `harness/skills/`.
- **Node 22+ required** (the test and E2E runners use native TypeScript stripping).
- **Dependencies trimmed** to `proper-lockfile` and `string-width`; `ajv` and `simple-git` were
  declared but unused.

### Fixed

- **Concurrent plan writes could lose edits.** `writeTaskList` read the plan, checked `baseRevision`,
  then wrote — three steps with no mutual exclusion, so two writers that both read revision N both
  passed the check and both wrote N+1. Measured at 2 lost updates in a 6-way fan-out. The whole
  read-apply-write now happens under an exclusive lock, and fails closed rather than racing.
- **Plan writes silently dropped task fields.** Round-tripping through the extension rebuilt each
  task from a fixed shape, discarding `difficulty`, `modelHint`, `criteria` and anything else. Updates
  now merge onto the stored task, so unknown fields survive.
- **The tested code was not the shipped code.** The extension carried inlined copies of the plan
  engine and the widget; the test suite exercised `src/`, which the extension never called. One
  implementation now, in `src/`.
- **Status aliases failed dependency validation.** `rework.ts` and `replan.ts` parsed the plan raw, so
  a task stored as `"done"` never compared equal to `"complete"` and every amendment to such a plan
  was rejected — with a message claiming a task in flight had unresolved dependencies.
- **A nested lock deadlocked against itself.** The new sync lock used `<path>.lock`, the same
  directory `proper-lockfile` uses, so a caller holding the async lock blocked the event loop waiting
  for a directory it already owned. The sync lock now uses `<path>.ilock`.
- **Locks were held across whole agent turns** with an 8-second staleness timeout, meaning any turn
  longer than eight seconds left a lock another process could steal. Critical sections are now
  milliseconds.
- **`require()` in an ESM module** meant the rich tool renderers silently never loaded.
- **`process.cwd()` in the context hook** instead of the session's project directory.
- **The widget overran its frame below 40 columns.** The progress row now degrades instead of padding
  past the edge, and unboxed output is clamped to the requested width.
- **Ambiguous-width glyphs misaligned the widget.** `string-width` reports `⚠ ↷ ▸ ✓ ·` as two columns;
  terminals draw them in one. Width measurement now pins them.
- **Truncation destroyed ANSI styling**, bleeding colour into the rest of the line.
- **`gateHistory` grew without bound** over a long run. Capped at 500 entries.
- **A type-only import of `AddressInfo`** made the dashboard module fail to load under type stripping.
- **A raw NUL byte in a source file** made `grep` and `file` treat the module as binary.

### Added

- **Continuous run driver** (`src/loop.ts`). `/infinity:run` validates, advances, re-briefs and keeps
  going until the pipeline completes or a guard fires: no-progress detection, wall-clock and
  iteration ceilings, retry budgets, and a human brake (`/infinity:halt`, `paused`, `harness/STOP`).
  Every stop names its reason.
- **New terminal widget.** Phase rail, progress meter, task window centred on the active task,
  dependency references, subtasks under the task actually being worked. Responsive to ~58 columns,
  ASCII fallback on non-UTF-8 locales, colour degradation from truecolor to none.
- **New web dashboard.** Same information design for the browser: stacked progress meters that show
  stuck work as colour rather than absence, gate panel, alerts strip, 5-second self-refresh with
  backoff. Read-only, loopback-only, and it never runs the gate.
- **Deterministic gate suite** with per-phase checks, task-scoped validation, and advisory checks that
  report without blocking.
- **E2E suite** (`npm run e2e`): 11 scenarios, 79 assertion groups, over real temp projects, real git
  repos and real child processes — including a concurrency fan-out with an unlocked control that
  demonstrates why the lock is load-bearing.
- **Test runner** (`npm test`): 20 files, plain `node:assert`, no framework.
- `.bak` recovery for a corrupt plan file.
- A `LockTimeoutError` a caller can actually act on.

### Changed

- **Model routing ships vendor-neutral.** Every slot is empty by default, meaning "use whatever model
  pi is already configured with". Installing the harness no longer silently redirects work to a
  specific third-party model.
- **Pi-only.** Support and references for other agent systems were removed; this is a pi extension
  and nothing else.
- The dashboard refuses to bind to a non-loopback interface without an explicit opt-in, and serves a
  CSP tight enough that an escaping slip cannot become script execution.
- Documentation rewritten: README, AGENTS.md, and `harness/docs/ARCHITECTURE.md`.

---

Earlier releases (0.2.0 – 1.2.0) were developed under the `pi-harness` name and are not carried
forward here; that history is in the git log.
