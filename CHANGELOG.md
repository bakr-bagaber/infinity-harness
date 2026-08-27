# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.6.5] — 2026-08-27

Routing is honest about handoff, research knows how deep to go, and the human reads the same wiring the runner does.

### Added

- **Research depth tiers.** Wizard asks `How deep should research go?` only when `research` is in the pipeline — `standard` (Deep 3 tasks ≥5 sources ~800), `deep` (Very Deep 5 tasks ≥7 sources ~1800), `comprehensive` (Literature Review 7 tasks ≥15 annotated ~5000). `harness/config.json: researchDepth` persists it, `STARTER_TASKS_BY_DEPTH` feeds `seedPhaseIfEmpty`, `checkResearchDoc` enforces the right floor, and `harness/skills/deep-research.md` codifies the `process` skill per depth. `src/intake.ts` surfaces `Research  <depth>` in the intake summary.

- **`harness/skills/deep-research.md`.** Process skill for the RESEARCH phase — depth-gated task/proof table, prior-art citation mandate, falsification experiment.

- **Dashboard actually shows its URL and the handoff→model contract.** `WidgetState.dashboardUrl` + `WidgetState.handoffModelNote` are populated from the live `remoteServer.url` and from `handoffModelNote(handoff)`; terminal header renders an `OSC 8` clickable `Dashboard: …` line, web dashboard renders `dash-url` + `handoff-note` under the masthead.

### Changed

- **Model routing follows handoff (Option A: hardest wins in the bucket).** `src/scheduler.ts: effectiveDifficultyForTask(task, handoff, list)` — `task/subtask` keeps own difficulty (subtasks inherit parent), `phase/feature/sprint/goal/off` collapses the bucket to its hardest (`easy < moderate < difficult`). `spawnWorkers` and `extensions/infinity-harness:index.ts` (`applyRouting` + `routingSummaryForBrief` + brief line) all read `config.session.handoff` each call; `src/intake.ts: HANDOFF_QUESTION` help text now states `Model per …` per choice. `src/handoff.ts` wording updated to match.

- **Seeding + config defaults.** `src/core/init.ts` writes `researchDepth` (`deep` when research enabled), `src/core/config.ts` defaults it, `src/core/phases.ts` returns the depth-appropriate starter set via `loadConfig` (no raw file read), `src/remote.ts` keeps the read-only dashboard read via `require` deferred import so pack audit stays green (`42` modules reachable).

### Fixed

- **Wizard ate its own answer.** Real-pi `research-first` and `build one` → research handoff paths previously timed out because depth answer matched the question title not option text and consumed the wrong line; e2e now answers depth with regex on option (`/Very Deep/`), research gate fixture length raised to `40×` so `deep = 1800` passes, and both realpi `wizard` + `custom` + `coldstart` `a custom workflow …` are green.

- **Second reuse init lost its saved workflow.** `coldstart-reuse` answered with a bare `Client work \(yours\)` line that no longer matched after research re-enabled depth intake; now answered `Very Deep` so the workflow survives.

- **Gate fixture regression.** `research.md` fixture at `20×` was `1152` chars — short of the new `deep 1800` floor — caused `the whole pipeline …` stall; corrected to `40×` (`2280`) so `research: pass` remains single-shot.

- **`src/intake.ts` CRLF drift.** Full-file rewrite was display-only (line endings); fixed to LF and only the 25-line surgical change retained.

- **Extension ESM require shim.** Prior `require("../../src/scheduler.ts")` in `widgetStateFor` broke ESM and never surfaced `handoffModelNote`; inlined pure map instead.

### Verified

- `tsc --noEmit` clean, `34/34` unit, `15/15` e2e (`coldstart 12/12`, `realpi 10/10`), `42` modules reachable via `package` scenario. `tests/skills.test.ts` bumps shipped skill count `28 → 29`, `tests/intake.test.ts` asserts `How deep …` + `Research deep` summary.

## [2.6.4] — 2026-08-25

`feature-criteria` now ignores seeded `phase-*` scaffolding so `DEFINE` does not pass on the
research seed alone. Same `phase` field, same `seedPhaseIfEmpty`, same worker path — just the gate.

## [2.6.3] — 2026-08-25

Research was shallow because it had no tasks — one search, doc, PASS. Now it follows the same
mechanism as every other phase: three starter tasks `research/r1-3` with subtasks, same `seedPhaseIfEmpty`
trigger on loop entry (0 tasks \& gate fails), same phase-scoped progress and same worker pickup
(`scheduler` scoped to `research`). No special code for research. Synthetic `convergence` walk stays clean
by only seeding when gate fails, so empty `DEFINE` test projects don't dirty.

## [2.6.2] — 2026-08-25

Publish 2.6.1 left the tarball staged on the registry awaiting an attestation that never arrived; npm
republish is blocked on a staged version. Bumping to 2.6.2 to clear the staging queue — same code as 2.6.1.

## [2.6.1] — 2026-08-25

Every active level now blinks together, subtasks show up where they always should have, and the TUI
fits the whole chain on one line per parallel lane.

### Fixed

- **Dashboard actually blinks the active branch.** Phase rail pulsing was faint and only the rail. Now
every active box (`goal`, `sprint`, `feature` currently being developed, plus all parallel `task`/`subtask`
lines) pulses with a stronger accent ring; legend items are fully visible (`is-zero` is now `opacity: 1`) so rework/blocked/in-progress are not faded out; subtasks always appear via the dashboard (covers `display.subtask: active → all`) and are not lost when the task was only `in_progress`.

- **TUI is one line per lane, not the whole tree.** Former indented 5-level tree listed every level at once and overflowed narrow terminals. Now: headline goal, one line `phase · feature · task desc · sprint · > subtask` per active/pending lane (parallel lanes each on their own line, `display.levels` still hides the names, `task: false` shows shape not work), overview shape still shows sprint/feature tier names.

- **Windowed 120-task huge plans elided with `… N above / below` on both surfaces**, so 120 tasks never render 120 rows. Colour-stripped boxed frame still exactly `width` columns.

### Added

- `renderDashboard` imported in `scripts/e2e.mjs` — the `all five levels reach the screen` assertion now reads from the authoritative dashboard surface rather than the compact TUI lane. Verified: `34/34` unit, `15/15` e2e.

## [2.6.0] — 2026-08-25

Every unfinished thought from the current loop now has a budget, a lane, and a worker. One generic
pipeline — no per-phase special cases.

### Added

- **Every phase owns tasks.** `task.phase?` + `feature.phase?` (`effectivePhase = task.phase ??
  feature.phase ?? "build"`), phase-scoped helpers `tasksForPhase/featuresForPhase`,
  `computeProgress(phase)/nextActionableTask(phase)`, starter tasks `define/d1-d2 + plan/p1-p2` seeded only when the phase is empty *and* its gate fails (so `convergence` stays clean and `DEFINE rev 0 0/0` no longer idles on `task` handoff). Old plans without `phase` still \= `build`.

- **Parallel on every level.** New `src/scheduler.ts` with `execution: { parallelAt: "task",
  maxWorkers: 3 }` (choices `off | goal | phase | sprint | feature | task | subtask`, 1–16). Default is
  `task × 3` — most efficient here; `goal` runs goals as parallel pipelines. Wizard asks after routing;
  `/infinity:config` → Execution exposes both knobs. Workers are isolated
  `tmp/infinity-harness/<run>/<feature>/<task>/attempt-N` with `model = resolveModel(task)` and
  `thinking = resolveThinking(task)` per task.

- **Per-level retry with per-level ladder.** `retry.levels: { goal 2, phase 2, sprint 2, feature 2, task 10, subtask 3 }` + `retryPerLevel` counters. `isRetryExhausted` checks finest first; a `task` pass zeroes `subtask` (`zeroLowerOnPass`), etc. Every level has its own `LoopState.perLevelEscalation` (`tried[]`, `fingerprints`, `consultedCount`) — the ladder `retry→reframe→consult→rework→replan→master` climbs per level with the task's difficulty and `master` once (consult also escalates thinking: `resolveThinkingForConsult(nextTier)`).

- **Main is dashboard only.** `loop.decideNext` fire-and-forget `spawnWorkers` scoped to `currentPhase` when `execution.parallelAt !== "off"` — the main session never edits the plan, it polls `fingerprint.json/output.log` and leaves `infinity_plan` to the workers. Dashboard `remote.buildRemoteState` streams `execution` + the 6 most recent worker `outputTail`s; widget follows the active `nextActionableTask(phase)` task.

- **Handoff/brief built for multiple phases.** `activePlanKeys` and `brief.task` prefer the current phase's next task before falling back to global, so `task`-granularity handoff (task fires all coarser levels) actually triggers after `research → define`. `BUILD`'s `tasks-complete` gate is now phase-scoped via `computeProgress(currentPhase)` (`effectivePhase`).

### Fixed

- `replan.amendPlan` preserves `phase` on tasks and features via `toStoredTask` / `addFeatures.phase`; a mid-run `define` amendment no longer falls back to `build`.
- `rework` / `replan` / `unstuck` keep their budgets (`maxReworksPerRun`, `maxReplansPerRun`, `consultation`, `review.allowBackward`) and were proved still working after the unified phase, parallel + per-level retry changes (`34/34` unit + `15/15` e2e, including `realpi` dialogs + `convergence` `define → ship`).

### Verified

- `tsc --noEmit` clean, `34` unit test files, `e2e 15/15` (including `realpi` five sessions + `convergence`, `package 42 modules reachable`). `harness/docs/plans/2.6-unified-phase-parallel-workers.md` keeps the user comments that drove this release.

## [2.5.1] — 2026-08-25

### Fixed

- **Routing actually drives the session.** `harness/model-router.json` previously persisted the tier
  choices but never called `ctx.setModel`/`ctx.setThinkingLevel`. Now `before_agent_start` and
  `session_start` resolve `harness/model-router.json` for the next actionable task and switch
  the pi session model + thinking, surface it as `infinity-model` in the footer and as
  `Routing: f1/t1 → prov-a/model-a · thinking low` in the brief/system prompt; `/infinity:config`
  and `/infinity:models` already showed the wiring, now the session honors it. Proved by
  `tests/routing-live.test.ts` + 15/15 E2E (including `realpi` dialogs) all green.
- **`infinity_validate` auto-advance scoped to doc phases.** Only `research/define/plan` hops on
  PASS in autopilot; `build` and later require explicit `infinity_advance` (or the armed
  `agent_settled` loop) so `build → verify → review` no longer skips a phase in one tool call.
  Wizard routing queue aligned in `scripts/e2e.mjs` + `tests/intake.test.ts`; full granularity
  hierarchy covered in `tests/handoff.test.ts`.

## [2.5.0] — 2026-08-25

### Added

- **Wizard picks models and thinking per tier + consulting master.** `/infinity:init` now asks which
  models and thinking levels to use for easy/moderate/difficult tiers and for the consulting master
  (with `off/minimal/low/medium/high/xhigh/max` plus `inherit`). Persisted in
  `harness/model-router.json` via `thinkingByDifficulty`/`thinkingMaster`/`thinkingDefault`; exposed
  via `/infinity:config` → Models.

- **Customizable handoff granularity.** `goal → phase → sprint → feature → task → subtask`.
  Wizard and `/infinity:config` both offer `goal` (single-session alias for `off`), `phase`
  (old default), `sprint`, `feature`, **default `task`**, `subtask`, and `off`. A finer choice
  implies coarser boundaries (picking `task` also hands off on feature/sprint/phase). Fixed:
  `task`-scoped handoff previously never fired because only `phase` was compared.

- **Dashboard blinks the active branch.** Phase dot `pulse`, current feature/sprint/goal cards and the
  active task row now pulse while being developed; `prefers-reduced-motion` disables them.

### Fixed

- **Research autopilot stalled after pass.** `infinity_validate` now auto-advances on PASS when
  the phase's mode is `autopilot` (mirrors `decideNext`), so `research → define` no longer requires
  manually typing `continue`.
- **`alt+j/k/o` never fired.** Editor shortcut only runs when the editor has focus; the TUI
  selector/overlay swallows input. Added `KeyId` shortcuts plus a raw `onTerminalInput`
  fallback (`\x1bj/k/o`) installed on `session_start`.
- **Handoff threshold `0.7 → 0.6`.** Long BUILD phases now hand off earlier, under the context
  window before compaction.

## [2.4.0] — 2026-08-24

Two settings that were one switch each, and one switch turned out to be the wrong shape for both
questions.

### Added

- **A mode per phase, not a mode per run.** "copilot" and "autopilot" could not say "let it define
  and plan on its own but show me the review", and that is a thing people want. Every phase now
  carries its own mode: `autopilot` advances when the gate passes, `copilot` stops and waits for
  your signature. The two familiar words survive as two named points in that space rather than the
  only two points in it, and every phase except INIT can be a checkpoint — the three that decide
  *what gets built* are the ones that usually pay for themselves, but that is a default rather than
  a limit.

- **Five workflows ship, and you can build your own.** `copilot`, `autopilot`, `spec and ship`
  (you sign the scope going in and the release coming out), `research first`, and `every gate`.
  Building one is its own short flow: pick the phases, then say for each whether it stops for you.
  Name it and it is kept — in `~/.pi/agent/infinity-harness/`, with *you* rather than with the
  project, because a workflow you designed is worth as much on the next one. It is then the first
  thing offered there.

  Built-ins are read-only, and their names cannot be taken. "copilot" has to mean the same thing in
  every conversation about this tool; someone who wants a different copilot makes their own and
  gives it their own name.

- **`/infinity:workflow`** — choose one, build one, switch by name (`/infinity:workflow
  spec-and-ship`), or `list` what is available and what you are on. `/infinity:config` →
  **Workflow** edits one phase at a time. All of it changes at any time and takes effect at the next
  gate: three phases into a run is exactly when someone realises they do want to see the review.

- **Display templates.** Shipping all five plan levels to everyone was the wrong answer for the same
  reason shipping two was: one person works in sprints and never opens a subtask, the next has no
  sprints and lives in the subtask list. Four ship — `focus`, `everything`, `overview` (the shape,
  no tasks), `worklist` (tasks only, no rail) — and anything else is chosen level by level: the
  five plan levels, the `done/total` counts, the `← #3` dependency labels, the acceptance criteria,
  the phase rail, the progress meter, the alert strip, and how many rows the terminal shows before
  it scrolls. Name what you end up with and it is saved with you like a workflow.

- **`/infinity:display`** — pick a template, choose level by level, switch by name, or `list`.
  `/infinity:config` → **Display** edits the same things one at a time.

- **The widget and the dashboard read the same setting.** Configure how you like to read a plan
  once, not twice.

### Changed

- `harness/config.json` gains `phaseModes`, `workflow` and `display`. A 2.3 config is migrated on
  read: its three-phase `approvals` becomes the equivalent modes and is labelled with the workflow
  it amounts to, so a project mid-run keeps exactly the approvals it was configured with and nobody
  has to edit JSON to upgrade. The legacy field is kept in step on write.
- Hiding a plan level hides the row, never the work beneath it: turn off sprints on a plan organised
  into sprints and the features move up one indent rather than vanishing, and task numbers do not
  shift, so `← #3` still points at the same task. A task nobody can see is a task that gets stuck
  forever.

### Fixed

- **`initHarness` ignored a caller that passed the old `approvals` shape** once `phaseModes`
  existed, silently producing an autopilot run. It falls back to `approvals` when no modes are
  given — the same rule `loadConfig` applies to an older file.

---

## [2.3.1] — 2026-08-24

*(2.3.0 was staged at the registry and never completed; 2.3.1 is that release plus the last two
fixes below, and is the first version of this work anyone can install.)*

Five bugs were reported against 2.1.0 by someone actually using the thing. Every one of them was
real, none of them could be seen by a test that mocks pi, and finding out why led to the change
that matters most in this release: **the suite now drives a real `pi` process.**

### Added

- **A fresh pi session per boundary.** A harness that never starts a new session is a harness whose
  context window only ever grows: by the tenth task the model is re-reading the history of the
  first nine in order to do the tenth. It pays for those tokens on every call, compacts them into a
  lossy summary once the window fills, and on a small model simply drowns.

  Nothing the harness knows was ever in the conversation — the plan, the phase, the gate history,
  the retry budgets and the escalation ladder are all files. So a session boundary costs one thing:
  the brief, which is what the agent should have been working from anyway. `session.handoff` is
  `phase` by default, `task` for the cleanest possible context, `off` for the old behaviour; any of
  them also hands off early once the context passes `session.contextThreshold`, because a handoff
  that arrives after compaction has arrived too late to be the thing that prevented it.

- **A run that outlives its sessions.** `harness/run.json` holds whether a run is armed, its id, and
  how many sessions it has spent. `/reload`, `/resume`, closing the terminal, and every handoff now
  resume the same run instead of quietly starting a new one with fresh budgets.

- **A start-up wizard that asks what is being built.** Choosing "autopilot" used to start the run
  immediately, with no idea and no scope, so the first thing the harness did was invent a project
  and start building it. Autopilot was being read as "you decide everything, including what I
  want". Two questions were tangled together and are now separate: *what are we building* (asked in
  both modes) and *who signs off on what* (the mode's actual meaning).

- **Approval gates on RESEARCH, DEFINE and PLAN.** The gate is a good referee for execution and a
  poor one for intent: it can prove a feature has acceptance criteria and cannot prove they are the
  right ones. In copilot all three are yours. In autopilot you tick the ones you want and forfeit
  the rest — forfeiting all three is the walk-away setting. `/infinity:approve` continues;
  `/infinity:approve <what is wrong>` sends the phase back carrying your words. A rejection is
  pinned to the state of the project when you made it, so you are not asked the same question again
  until the agent has actually changed something.

- **An optional RESEARCH phase**, before DEFINE, with its own role, gate and phase doc. The human
  gives an idea; the model comes back with prior art, the constraints that are real, at least two
  options with what each costs, a recommendation, what would falsify it, and the questions only a
  human can answer — which become the DEFINE interview.

- **All five plan levels on screen.** Goal → sprint → feature → task → subtask. Only two of them
  used to reach the human: the widget drew features and tasks, goals were a single title line, and
  sprints appeared *nowhere*, so a plan organised into sprints looked exactly like a plan that was
  not. `src/ui/planTree.ts` is one shared model of the plan's shape; the widget windows it and the
  dashboard renders all of it as collapsible tiers with counts at every level. A feature pointing
  at a goal that has since been deleted is still drawn — a task nobody can see is a task that gets
  stuck forever.

- **A scrollable plan widget.** Nine rows of a sixty-row plan read as a truncation, because the
  other fifty-one were unreachable without opening the dashboard. It is a window now: `alt+j` /
  `alt+k` scroll, `alt+o` expands, and `/infinity:scroll up|down|top|bottom|expand|collapse|follow`
  does the same without a keyboard. (`alt+`, not `ctrl+`: pi already binds ctrl+j, ctrl+k and
  ctrl+o in its editor, and a widget is not worth shadowing an editor key for.)

- **`scripts/rig/` — the suite drives a real pi.** A scripted OpenAI-compatible model server plus an
  RPC client that types prompts and slash commands, answers `ctx.ui.select` dialogs, and reads back
  the widget, the status line and the notifications a human would actually see. The new `realpi`
  e2e scenario covers startup, the wizard, a run spanning several real sessions, real
  auto-compaction, an approval round-trip, and `pi -p` not hanging.

- Three commands: `/infinity:approve`, `/infinity:handoff`, `/infinity:scroll`. Two settings groups:
  **Your approvals** and **Sessions**.

### Fixed

- **The harness did not survive compaction.** Its rules lived in the transcript, and a transcript is
  what compaction summarises: the agent came out the other side still holding the plan (it is on
  disk) but no longer knowing it was supposed to work from it, stop at a failing gate, or never
  mark its own work complete. Those rules now go in the **system prompt**, via
  `before_agent_start`, which is rebuilt every turn and is never summarised. The post-compaction
  re-brief is also delivered as `steer` rather than `nextTurn` when a turn is running — `nextTurn`
  waits for a human to type, which in an unattended run never happens, so the message that was
  supposed to rescue the agent sat in a queue while it carried on without it.

- **The loop did not survive its own handoff.** "Is a run armed?" was a `let` inside the extension
  closure, so it died with the pi session that held it. Worse, the run id was a `randomUUID()` per
  session: every new session looked like a brand-new run to `loadLoopState`, resetting the iteration
  ceiling, the wall-clock budget, the no-progress streak and the escalation ladder — every guard
  that makes walking away safe, reset by the mechanism that makes walking away possible.

- **`pi -p` hung forever on a harness project.** The session-start brief was queued with
  `deliverAs: "nextTurn"`, which waits for a user prompt. Print mode never has one. Every headless
  run hung at startup and nothing in the suite could see it, because nothing in the suite ran pi.

- **A second, hand-written copy of `PHASE_ROLE`** in `core/config.ts`. Adding a phase compiled
  cleanly and then silently reported the wrong role for it.

- **A rejected approval could spin forever.** The first version of the fix returned early from the
  loop when a rejection was still outstanding, which skipped the no-progress detector — an unbounded
  loop, the one thing this product exists to prevent. It falls through the normal failure path now,
  so strikes, budgets and the escalation ladder all apply, and a run whose agent ignores a rejection
  stops and says exactly that.

- **Commands that dead-ended before init.** `/infinity:next` printed a full page of pipeline
  instructions for a pipeline that did not exist; `/infinity:scroll` said nothing at all. All
  fifteen commands that need a harness now say so and name `/infinity:init`.

- **The phase picker did not offer RESEARCH** — a feature nobody could find.

- **A handoff in a one-shot `pi -p` run replaced the session out from under the instance that
  asked for it**, so every handler afterwards touched a torn-down context and pi reported
  "This extension ctx is stale after session replacement" on every turn. A headless run has no
  next turn to hand anything to, so it does not hand off — and the extension now stops touching
  pi the moment its session is shut down, whatever the reason.

- **A new phase counted as a stall.** The first failure of a phase was compared against the
  fingerprint taken when the *previous* phase passed — identical, because nothing had happened
  yet — so the run spent `retry` and `reframe` on the opening turn of every single phase, and
  arrived at the rungs that matter with the cheap ones already gone. A stall is the agent
  producing nothing when asked; a fresh brief has not asked yet.

- **The gate history counted every pass twice.** `runChecks` recorded the verdict and
  `transitionPhase` recorded it again, so the history read `define:pass → define:pass`, which says
  a phase had to be attempted twice — the opposite of what happened. Repeated *failures* are still
  every one of them: that is the fact a human comes back to read.

### Changed

- The dashboard shows every subtask, not only the active task's. The widget has nine rows and a job
  to do with them; the browser has a whole page and a scrollbar, and hiding four of the five plan
  levels there made it a worse copy of the widget rather than the place you go for the full picture.
- The widget carries `session N` once a run has spanned more than one, and says loudly when a phase
  is waiting for your signature — a run parked on a human otherwise looks identical to a run that
  quietly died.
- `describeInit` no longer tells you to describe what you are building. The wizard just asked.

---

## [2.2.1] — 2026-08-23

### Fixed

- **Reviewing a goal before the pipeline finished threw an internal error.** `GoalLoopStateError:
  Cannot update goal iteration 2 from status pending` — a phase name from inside the state machine,
  thrown at whoever called the tool. Reviewing early is legitimate: you can see a pass will not meet
  the goal well before the pipeline agrees, and waiting for a doomed pipeline to finish first is
  theatre. The review now records the pass itself and answers.

  Found by running the shipped package against a real project, in the first minute. Every test
  recorded a pipeline pass before reviewing, so not one of them ever asked what happens when a
  review arrives without one.

---

## [2.2.0] — 2026-08-23

Nine modules shipped in this package, typechecked, and passed their tests while no code path in the
running product could reach a single one — about 2,800 lines, advertised in the README. They are all
connected now, and connecting them found four reasons the most important of them had never worked.

### Added

- **The escalation ladder actually escalates.** `unstuck.ts` could always *choose* what to do when a
  run stalled — retry → reframe → consult → rework → replan → master, with budgets, fingerprint
  dedup and a cooldown — and nothing ever executed one. It was a chooser with no actuator, so
  `/infinity:run` did the only thing it could when the gate kept failing: count three strikes and
  stop. `src/escalate.ts` is the actuator. On a stall it climbs a rung, does the part that is ours
  (flipping tasks to `rework`, naming the model to escalate to) and hands the agent an instruction
  for the part that is the agent's. Every rung says something different; a run that gives up now
  names every rung it spent first.
- **The goal loop turns.** `goalSpec`, `goalLoop` and `goalState` are a complete outer loop that
  nothing ever drove, which meant the harness could finish a pipeline and declare "complete" without
  anyone asking whether the thing the human asked for was done. `src/goal.ts` drives it, and the
  mapping is the design: **one goal iteration is one full pass of the pipeline.** `/infinity:goal
  <what you want>` states it; when the pipeline finishes, the run asks whether the GOAL is met, not
  whether the plan is. A verdict of anything but `complete` must name what is still missing, and the
  pipeline rewinds to the first phase with that list carried into the brief — so the next pass plans
  for the remainder instead of rebuilding what the last review already accepted.
- **Five tools and three commands** for what was previously unreachable: `infinity_unstuck`,
  `infinity_rework`, `infinity_replan`, `infinity_spawn_worker`, `infinity_goal`, and
  `/infinity:goal`, `/infinity:unstuck`, `/infinity:rework`.
- **A `skills-load` advisory gate check.** The skills audit was the ninth orphan. It now runs at
  DEFINE and REVIEW over any skills a project ships, so a project finds out that pi will print a
  `[Skill conflicts]` block before its users do. Advisory: a malformed skill does not make the code
  wrong.
- **The widget shows which pass you are on and the last rung taken.** A second pass at a goal looks
  identical to a first one in every other part of the display, which is exactly when someone glances
  at a half-full progress bar and walks away thinking it is nearly done.
- **Two E2E scenarios** — `escalation` and `goal` — driving both through the real adapter over real
  projects, and the reachability allowlist in the `package` scenario is now **empty**.

### Fixed

Wiring the ladder in exposed why it had never worked, none of which its own passing tests could see:

- **`reframe` had no budget**, so it was eligible forever and shadowed every rung below it. The
  ladder could not climb past rung two — `consult`, `rework`, `replan` and `master` were unreachable
  through the function whose job was to reach them.
- **`rework` and `replan` were vetoed unless the working tree had moved.** A stall is *defined* by
  the tree not moving, so the two rungs that exist for exactly this situation could never fire in
  it. That guard is a review-bounce policy — do not bounce REVIEW backwards again if nothing changed
  — and it stays that for review bounces; the stuck ladder opts out explicitly.
- **The budgets counted effects on disk**, which only appear if the agent acts on the advice. A
  stuck agent does not, so the budget never moved and the ladder jammed, offering `replan` forever.
  Each rung now gets one turn per stall; the on-disk budgets still bound the run across stalls.
- **MASTER defaulted to a specific third-party model** — in a package whose 2.0.0 release promised
  every routing slot ships empty. The last rung of the ladder silently redirected the hardest work
  in the run to one vendor. It is `null` now, meaning "whatever pi is configured with", unless the
  user chose one.

### Changed

- A stalled iteration consults the ladder before the no-progress strike is spent, and a new rung
  resets the streak — a different attempt is not another repetition of the same one. This cannot run
  forever: every rung is bounded, so the ladder runs out, returns nothing, and the run stops with a
  full account of what was tried.
- `loop-state.json` carries the ladder's position. State written before it existed loads fine.

---

## [2.1.0] — 2026-08-23

You could not start, and if you had, you could not have got past the first gate. Both are fixed.

### Added

- **`/infinity:init`, and the `infinity_init` tool.** There was no way to create a harness. `pi
  install` put the extension in place and then every command answered *"No harness in this project
  (harness/config.json not found)"* — with nothing anywhere that made one. The package installed,
  loaded, and passed its entire test suite while being unusable.

  Init detects the stack and its lint/test/build commands, writes the config, an empty plan, the
  phase and role docs the brief points at, and starters for the documents the review gate demands,
  then hands the model its first brief. It asks two questions when there are dialogs and takes the
  detected defaults when there are not, so an unattended run never stalls on a prompt. It never
  overwrites an existing file, and `/infinity:init force` restores what was deleted without touching
  what was written.
- **Feature names, acceptance criteria and the run's goal are writable through `infinity_plan`.**
  Features are derived from task keys, so there was no input for their metadata — and the DEFINE
  gate requires criteria on every feature. The first gate in the pipeline could only be passed by
  hand-editing the plan file, which the brief explicitly tells you not to do.

  `features` merges by id and never deletes, because features are inferred rather than submitted;
  `tasks` keeps its omission-means-deletion rule. Leaving `tasks` out entirely is now distinct from
  sending `[]`: absent means "not touching them", empty still means "delete them all". Nesting tasks
  inside a feature — the obvious wrong guess — is refused with the shape that works.
- **A `coldstart` E2E scenario**: bare directory, `/infinity:init`, brief, plan, gate, advance,
  through the real adapter. Every leg of it was a defect before it was a test.

### Fixed

- **Six more shipped documents told the agent to run a CLI this package does not have** —
  `infinity-harness contract propose`, `decision "..."`, `rollback list`, `checkpoint create`. The
  2.0.2 guard only caught a hardcoded list of verbs, which by construction only ever catches the
  ones already found. It now looks at *where* the claim is made: inside a code fence or span, the
  package name followed by a word is a command line, and there is no command line.
- **The plan view hid the thing the model is marked on.** Reading the plan listed tasks but not
  features or their criteria — so the DEFINE gate judged something the model could not see. It now
  shows the goal, each feature, and its criteria, flagging any feature that has none.
- **Comments counted as document content.** `docCheck` stripped headings but not HTML comments, so a
  scaffolded file whose guidance lived in a comment would satisfy the gate that demanded it. A
  comment is instructions to the author, not content.

---

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
