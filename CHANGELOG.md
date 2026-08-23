# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.4] — 2026-08-23

### Changed

- **A domain skill now has to be pulled in by the task's own vocabulary.** Run against a real project
  the matcher offered `cli-design` for *"serialise plan writes so two workers cannot race on the
  lock"* — because the goal above it read "ship the payments rewrite behind a flag", and `flags` is
  on that skill's tag list. One incidental word is not vocabulary. A `domain` or `meta` skill must
  now clear the bar on tag hits alone; the phase ranks it but never qualifies it. `process` skills
  are unchanged — belonging to the phase is the whole point of them.

---

## [2.0.3] — 2026-08-23

### Fixed

- **`npm test` failed in any project that had actually been used.** The surface guard added in 2.0.2
  walked the filesystem for documents to check, so it also read the files the harness *writes* —
  `harness/session-handoff.md`, `harness/.run-prompt.md` — which are git-ignored scratch carrying
  whatever commands were current when they were generated. It now asks git what the repository
  ships. A test that fails because you ran the tool is a test people turn off.

---

## [2.0.2] — 2026-08-23

Everything here is one bug: the package told people to run commands it does not have. 2.0.1 fixed
some of them; this fixes the rest, and adds the test that makes the whole class impossible.

### Fixed

- **Every brief ended by telling the model to run a command that does not exist.** The last thing
  each brief said was `2. Run: harness validate` — a CLI that stopped existing when it was ported
  into `src/`. The brief is injected at session start and after every phase change; the model read
  that instruction, ran it, and got "command not found" every single turn. It now names the
  `infinity_validate` tool, and `/infinity:validate` for the human.
- **Three phase docs referenced `infinity_status`, which is not a tool.** It is `/infinity:status`.
- **36 mechanical-rename artefacts across 11 shipped documents** — "Run `the infinity_validate tool`"
  and friends, in the phase and role docs the brief points the agent at every phase.
- **`capability-acquisition.md` did not actually get rewritten in 2.0.1.** A `git rm` earlier in the
  same command failed, `&&` short-circuited, and the heredoc that was supposed to replace the file
  never ran — so 2.0.1 shipped the old text, still pointing at `infinity-harness capability add …`
  and at MCP servers pi cannot use. Rewritten, and verified this time.
- **`cli-design.md` used `infinity-harness init` as its example error message.**

### Added

- **`tests/surface.test.ts`** — the guard for all of it. It parses the tools and commands the
  extension actually registers, then holds every rendered brief and all 48 shipped documents to that
  list: no `infinity_*` tool or `/infinity:*` command may be named unless it exists, nothing may
  point at a command line this package does not have, and the rename artefact cannot come back. The
  changelog is exempt — its job is to name what a release removed. It found four defects the moment
  it was written.

---

## [2.0.1] — 2026-08-23

### Fixed

- **pi printed a skill conflict on every start.** `harness/skills/README.md` was a README, and pi
  loads *every* `.md` in a declared skills directory as a skill — so every session opened with
  `[Skill conflicts] … description is required`. The README moved to `harness/docs/skills.md`, and
  `tests/skills.test.ts` now audits the shipped skills against pi's own rules (frontmatter present,
  `description` non-empty and within length, `name` lowercase-and-hyphens, matching its filename, no
  duplicates, no UTF-8 BOM hiding the header). A warning the user saw at runtime is a failure we see
  at test time.
- **Four shipped skills told the agent to run a CLI that does not exist.**
  `capability-acquisition`, `building-tools`, `writing-skills` and the deleted MCP skill all
  instructed the model to register capabilities with `infinity-harness capability add …` — a command
  from the `dev-harness` ancestor that this package never had. An agent following them got stuck at
  3am on a command not found. Rewritten around what pi actually provides: a skill file in
  `.pi/skills/`, a script in the repo, or an extension via `pi install`.

### Removed

- **`building-mcp-servers.md`**, and every other reference to MCP. pi has no MCP client — no
  dependency, no configuration, no code — so a skill about scaffolding MCP servers and registering
  them could only send the agent somewhere pi cannot follow. This is a pi extension; MCP was
  another system's answer.
- **`harness/capability/sources.json` and `harness/tools/`.** Neither was read by any code, neither
  was published, and both documented the same missing CLI.

### Added

- **The brief names the skills that match the work.** The docs claimed it did; nothing implemented
  it. Every skill now declares a `kind` — `process` (belongs to its phase), `domain` (needs to share
  vocabulary with the task) or `meta` (asked for explicitly) — and the brief ranks them by phase
  position, tag hits and name mentions, showing the best two. A task about *"two workers racing on
  the lock"* gets `concurrency-async`; a bare BUILD task gets `tdd`; a task that matches nothing gets
  no section at all, because a padded section teaches the model to skip it.
- **`src/core/skills.ts`** — skill loading, header parsing and matching, resolved from the package so
  it works in an install with no project setup.
- **`src/core/skillsAudit.ts`** — pi's validation rules, reproduced strictly enough that a clean
  audit means a clean start. Also catches what pi does not: a duplicate name (pi keys skills by name,
  so one silently ceases to exist), a mistyped phase, a missing `kind`, and a name that disagrees
  with its filename.
- **A `package` E2E scenario** — `npm pack`, extracted and inspected. Every bug it looks for was
  found by a user after install and by nothing in this repository: a file pi rejects, a symlink out
  of the tree, a module the extension imports that npm did not publish, a UTF-8 BOM. The repo working
  tree is not the product; the tarball is.
- **A reachability guard.** "The tested code was not the shipped code" was this project's worst bug.
  The `package` scenario now also walks every import from the extension entry point and fails on any
  *new* module that ships without a path to it. Nine modules are unreachable today — `worker`,
  `unstuck`, `review`, `rework`, `replan`, the three `goal*` modules and the audit itself — and they
  are named in the test with the reason, so the debt is visible and cannot grow quietly.

### Changed

- `prototype` now leads with PLAN rather than BUILD — it answers a design question before you commit
  to one, and the phase a skill leads with is what decides its rank.
- Tag matching tolerates plurals, so a task about "two workers" matches the `worker` tag.

---

## [2.0.0] — 2026-08-23

Renamed from `pi-harness` to **infinity-harness**, and rebuilt from a working prototype into
something shippable. This is a breaking release: tool names, command names and the package name all
changed, and the extension no longer depends on an external repository.

### Breaking

- **Package renamed** `pi-harness` → `infinity-harness`.
- **Tools renamed.** `harness_task_list` → `infinity_plan`, `pi_harness_remote`/`harness_remote` →
  `infinity_dashboard`. New: `infinity_brief`, `infinity_validate`, `infinity_advance`. The goal-loop
  and worker-spawn tools were not carried over — their modules ship but nothing registers them (see
  the reachability guard in the `package` E2E scenario).
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
- **A model reference reached a shell unvalidated.** It is interpolated into the worker command, so it
  is now checked against a strict character set and refused rather than escaped — a typo cannot
  become a command substitution.

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
- **Test runner** (`npm test`): 21 files, plain `node:assert`, no framework.
- **Full configuration from inside pi.** `/infinity:config` opens an interactive menu covering models,
  pipeline, project commands, gates, loop budgets and retry budgets; `/infinity:config show` prints
  the lot as text and is what runs automatically when the mode has no dialogs. The menu is generated
  from one schema (`src/core/settings.ts`), so an option cannot exist in the file format and be
  missing from the UI.
- **Model tiers picked from pi's own models.** Config → Models offers the models pi has configured
  and can authenticate — session-scoped ones when scoping is set — for each difficulty tier, the
  master model and the default. Any tier can be handed back to "pi's current model".
  `/infinity:models` shows the available list beside the current routing.
- Values are bounds-checked before they are written, durations accept `24h` / `90m`, and the phase
  list is toggled item by item and stored in pipeline order rather than click order.
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
- **`strict: true`.** The whole tree typechecks under TypeScript strict mode, with ambient types added
  for `proper-lockfile`, which ships none.
- **Verified installable from npm** (`pi install infinity-harness`). pi loads extensions through
  `jiti`, which transpiles TypeScript at runtime, so the package ships `.ts` with no build step.
  Plain `node` refuses to type-strip inside `node_modules`; pi does not use plain `node` for this.

---

Earlier releases (0.2.0 – 1.2.0) were developed under the `pi-harness` name and are not carried
forward here; that history is in the git log.
