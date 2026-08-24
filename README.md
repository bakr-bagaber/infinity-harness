# infinity-harness

**A pi extension that keeps an agent building — correctly — for hours or days without you.**

Point it at a project, describe the goal, and walk away. infinity-harness drives the agent through a
gated pipeline, checks the work with deterministic gates rather than the model's own judgement, and
stops with a clear reason when it genuinely needs you.

```
╭──────────────────────────────────────────────────────────────────────────╮
│ ∞ INFINITY ──────────────────────────────────────────────── BUILD rev 42 │
│ ◈ Ship the payments rewrite behind a flag                                │
│                                                                          │
│ ● define ─ ● plan ─ ◉ BUILD ─ ○ verify ─ ○ review ─ ○ ship               │
│                                                                          │
│ ▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱  45%                  5/11 tasks · 1/2 features │
│ ⚠ 1 blocked · ↷ 1 rework · retry 2/10 · session 7                        │
│                                                                          │
│ ▤ Checkout                                                          5/11 │
│   ▸ feature-002 · Checkout flow                                      2/5 │
│     ●  4 validate cart totals against catalogue prices                   │
│     ●  5 apply stacked discount codes with precedence rules         ← #4 │
│     ◐  6 handle partial refunds across split tenders            ← #4, #5 │
│          ✓ unit tests for tender split                                   │
│          ▸ integration test against sandbox                              │
│          · audit log entries                                             │
│     ○  7 emit refund webhook                                        ← #6 │
│     ⚠  8 reconcile ledger nightly                                   ← #6 │
│   ⋯ 3 below  alt+j/k scroll · alt+o expand                               │
╰──────────────────────────────────────────────────────────────────────────╯
```

All five levels of the plan — goal, sprint, feature, task, subtask — with the window
centred on the work. `alt+j` / `alt+k` scroll it, `alt+o` expands it, and
`/infinity:dashboard` shows the whole thing in a browser.

---

## Why it exists

Left alone, a coding agent drifts. It declares work finished that isn't, forgets what it already
did, re-solves the same problem three different ways, and — worst of all — keeps going long after it
stopped making progress. Pair it with a small or cheap model and all of that gets worse.

infinity-harness fixes that by taking three decisions away from the model:

1. **When work is done.** A deterministic gate decides, not the agent. Same tree, same verdict, every
   time. No agent marks its own homework.
2. **What happens next.** The phase pipeline is forward-only and one step at a time. The agent cannot
   decide it's bored of BUILD and jump to SHIP.
3. **What to remember.** The plan, the phase and every budget live in files, so the run starts a
   **fresh pi session at each boundary** instead of dragging the whole history of the run into every
   request. Small models stop drowning; long runs stop turning into summaries of summaries.

Everything else — the retries, the model routing, the escalation ladder — exists to keep those
decisions honest over a very long run.

And one decision stays yours: **what gets built**. The gate can prove a feature has acceptance
criteria; it cannot prove they are the right ones. So the run stops and asks you to sign off
RESEARCH, DEFINE and PLAN — always in copilot, and in autopilot for whichever of them you choose to
keep.

## Install

Requires **Node 22+** and [pi](https://github.com/earendil-works/pi-coding-agent).

```bash
# from npm — project-local, so the team shares it via .pi/settings.json
pi install npm:infinity-harness -l

# or globally
pi install npm:infinity-harness

# straight from the repo
pi install git:github.com/bakr-bagaber/infinity-harness

# or from a checkout
pi install ./infinity-harness -l

pi list   # confirm it loaded
```

The package ships TypeScript. pi loads extensions through `jiti`, which
transpiles at runtime, so there is no build step and nothing to compile.

## Use it

```bash
cd your-project
pi
```

Then, once, in that project:

```
/infinity:init
```

It detects your stack and its lint/test/build commands, then asks you five questions:

| | |
|---|---|
| **How involved do you want to be?** | copilot — you approve the definition and the plan · autopilot — you choose what to approve, if anything |
| **What are you building?** | One or two sentences. Asked in *both* modes, because a run with no goal has no business inventing one. |
| **Research it first?** | Adds an optional RESEARCH phase before DEFINE: prior art, constraints, options with costs, a recommendation, and the questions only you can answer. |
| **Which phases do you sign?** *(autopilot only)* | RESEARCH, DEFINE, PLAN — tick any, all or none. None is the walk-away setting. |
| **When should it start a fresh session?** | Every phase (default) · every task · never |

Then it writes `harness/` — the config, an empty plan, the phase and role docs, and starters
for the documents the review gate will demand — and hands the model its first brief. It never
overwrites a file that already exists, and `/infinity:init force` restores anything you
deleted without touching what you wrote.

From then on, every session opens with a brief: phase, role, current task, acceptance criteria,
the craft skills that match the work, and what to do next. Do the work, then:

```
/infinity:validate     run the gate for this phase
/infinity:run          hand it the wheel: validate → advance → re-brief, until done or stuck
/infinity:approve      sign off the phase waiting for you — or send it back with a note
/infinity:status       where the run is right now
/infinity:scroll       move the plan widget: up · down · top · bottom · expand · follow
/infinity:handoff      continue this run in a fresh session, by hand
/infinity:config       change any setting, including which model runs which tier
/infinity:models       what models pi has, and how they are being routed
/infinity:dashboard    open the live web view
/infinity:goal         state a goal and pursue it across passes
/infinity:unstuck      what the escalation ladder would try next
/infinity:rework       send a task and its dependents backwards
/infinity:halt         take the wheel back
```

`/infinity:run` is the point of the tool. It keeps the loop turning without you.

## Who decides what

The two words are about **who signs off**, not about how autonomous the agent is. Both modes
run the same pipeline, the same gates and the same loop.

| | copilot | autopilot |
|---|---|---|
| RESEARCH, DEFINE, PLAN | you approve each one | you pick which, if any |
| Everything after PLAN | the gate decides | the gate decides |
| When it is right | you care what gets built | you have said what you want and you are leaving |

When a phase you signed up for passes its gate, the run **stops and asks you** rather than
advancing. Approving continues it; answering with a sentence sends the phase back carrying your
words, so it is redone against your objection rather than redone identically:

```
/infinity:approve
/infinity:approve the criteria say nothing about refunds
```

A rejection is pinned to the state of the project when you made it, so the run will not ask you
the same question again until the agent has actually changed something in response. If it never
does, the run stops and says so instead of nagging forever.

## One run, many sessions

A harness that never starts a new pi session is a harness whose context window only ever grows.
By the tenth task the model is re-reading the history of the first nine in order to do the
tenth — paying for those tokens on every call, compacting them into a lossy summary once the
window fills, and, on a small model, simply drowning.

Nothing the harness knows lives in the conversation. The plan, the phase, the gate history, the
retry budgets and the escalation ladder are all files under `harness/`, so a session boundary
costs one thing: the brief — which is what the agent should have been working from anyway.

So the run hands itself to a fresh session at each boundary, and the replacement picks up
exactly where the last one stopped:

| Setting | Fresh session when |
|---|---|
| `phase` *(default)* | the pipeline advances a phase, or a goal pass finishes |
| `task` | that, plus every time the run moves to a different task |
| `off` | never — one session for the whole run |

Any of them also hands off early once the context passes `session.contextThreshold` (0.7 by
default), because a handoff that arrives after compaction has arrived too late to be the thing
that prevented it.

The run itself — its id, its wall-clock budget, its iteration ceiling, its no-progress strikes
and its position on the escalation ladder — lives in `harness/run.json` and is the same run
across every session it spans. `/reload`, `/resume`, closing the terminal and reopening it all
resume the same run rather than quietly starting a new one with fresh budgets.

The widget shows `session 7` once a run has spanned more than one.

### The first pass through

DEFINE wants acceptance criteria on every feature, so start by telling it what you are building.
The agent writes that through `infinity_plan`:

```jsonc
{
  "goal": "Ship the payments rewrite behind a flag",
  "features": [
    { "id": "feature-001", "name": "Checkout flow", "criteria": ["refunds reconcile against the ledger"] }
  ]
}
```

Features carry names and criteria; tasks are a separate list keyed `feature-001/task-001`, and
arrive in PLAN. Omitting a task deletes it — that is the rule that keeps the plan honest — but
omitting a *feature* just leaves it alone, because features are inferred from task keys rather
than submitted.

## Configuration

Everything is configurable from inside pi:

```
/infinity:config        interactive menu
/infinity:config show   print the whole configuration as text
```

The menu is generated from a single schema, so every option the file format
supports is reachable from the UI — the two cannot drift. Editing
`harness/config.json` and `harness/model-router.json` by hand stays entirely
valid; the menu is the same data with prompts and bounds checking attached.

| Group | Covers |
|---|---|
| **Models** | Which model runs each difficulty tier, the master model, consultation budget |
| **Pipeline** | Which phases run, copilot vs autopilot, role strictness, pause |
| **Your approvals** | Which of RESEARCH / DEFINE / PLAN stop and wait for your signature |
| **Sessions** | Fresh session per phase or per task, the context threshold, the carry note |
| **Project commands** | lint / test / coverage / build — what the gate actually runs |
| **Gates** | Enable, coverage threshold, placeholder rejection |
| **Continuous run** | Iteration ceiling, wall-clock budget, no-progress strikes |
| **Retry budgets** | Attempts per task, feature and phase |

## The pipeline

```
[research] → define → plan → build → verify → [simplify] → review → ship
```

| Phase | What it's for | Gate opens when |
|---|---|---|
| **research** | Find out what it actually has to be *(opt-in)* | `harness/docs/RESEARCH.md` says something a human could argue with |
| **define** | Write down what's being built and how you'll know it's done | Every feature has acceptance criteria |
| **plan** | Break features into ordered, dependency-aware tasks | Tasks exist and criteria are set |
| **build** | Implement, one task at a time, tests alongside | Lint, tests, coverage pass; no placeholders; every task complete |
| **verify** | Prove behaviour; hunt what the tests miss | Tests and coverage pass on a clean tree |
| **simplify** | Delete more than you add *(opt-in)* | Tests pass, no empty dirs, clean tree |
| **review** | Judge it as if someone else wrote it | Rubric, README, architecture doc and decisions are real; branch level with upstream |
| **ship** | Tag, changelog, leave it clean | Clean tree, tagged, changelog, README, licence, no placeholders |

Enable or disable phases in `harness/config.json` under `phases.enabled`, or in the wizard.
RESEARCH and SIMPLIFY are off by default.

RESEARCH runs before anything is specified, and answers the question DEFINE assumes: is this the
right thing to build at all? It writes prior art, the constraints that are real, at least two
options with what each costs, a recommendation, what would make that recommendation wrong, and the
questions only you can answer — which become the DEFINE interview. Turn it on when the human gave
an idea rather than a specification.

## When it gets stuck

Stopping safely is the easy half. The hard half is trying something *else* first, and that is the
escalation ladder: when a run stalls — the gate fails and the working tree has not moved, meaning
the agent produced nothing — `/infinity:run` climbs it before spending a strike.

| Rung | What it does |
|---|---|
| **retry** | One more attempt. Sometimes a run is just slow. |
| **reframe** | State the assumption you have been working under, say why the evidence contradicts it, then try a different approach. |
| **consult** | Escalate to a stronger model, one step up the difficulty ladder. |
| **rework** | Flip the task and everything that depends on it back to `rework`. Work built on a broken thing is suspect until re-proved. |
| **replan** | The plan is wrong: something this needed was never planned. Amend it. |
| **master** | Last resort. State the problem from scratch, including what has been ruled out. |

Each rung gets one turn per stall, and each is bounded — reworks and replans have budgets, `consult`
has a per-task limit, `master` fires once per run. When the ladder runs out, the run stops and names
every rung it spent. Real progress resets it: a moving tree means a new problem, and a new problem
gets a fresh ladder.

`/infinity:unstuck` shows what it would try next without doing it.

## Goals, and knowing when you are actually done

A finished pipeline is not a met goal. The gate decides whether the **work** is done; it has no
opinion on whether the work was the *right* work, because it only ever sees the plan — and the plan
is just what you thought the goal needed when you wrote it.

```
/infinity:goal Ship the payments rewrite behind a flag
```

That states the goal and starts pass 1. One pass at the goal is one full trip through the pipeline.
When the pipeline completes, the run does not end: it asks whether the goal is met.

- **complete** ends the run.
- Anything else must name what is still missing — and the pipeline rewinds to the first phase with
  that list carried into the brief, so the next pass plans for the remainder rather than rebuilding
  what the last review already accepted.

Bounded by an iteration ceiling and a wall clock, both configurable. The widget shows which pass you
are on, because a second pass looks exactly like a first one otherwise.

## Knowing when to stop

This is the part that makes an unattended run safe. `/infinity:run` halts on any of:

| Guard | Default | What it catches |
|---|---|---|
| **No progress** | 3 strikes | Gate keeps failing and the working tree hasn't moved — the agent is spinning, not working |
| **Wall clock** | 24h | A run you forgot about |
| **Iterations** | 2000 | Runaway loops that stay under the clock |
| **Retry budget** | 10/task | One impossible task eating the whole run |
| **Pipeline complete** | — | Final phase passed with every task done |
| **Human brake** | — | `/infinity:halt`, `/infinity:pause`, or `touch harness/STOP` |

Every stop names its reason. You come back to an explanation, not a mystery.

Tune the budgets in `harness/config.json`:

```json
{
  "loop": {
    "maxIterations": 2000,
    "maxWallClockMs": 86400000,
    "noProgressLimit": 3
  }
}
```

## The plan is a file

`harness/features/feature-list.json` is the single source of truth. The widget, the dashboard and the
brief all read it; nothing caches a second copy.

The agent edits it by submitting the **complete** task list through the `infinity_plan` tool:

- **Omission means deletion** — for tasks. One unambiguous rule beats incremental edits a model
  loses track of. Leaving the `tasks` field out entirely is different from sending an empty one:
  absent means "not touching them", empty means "delete them all".
- **Features are a merge, not a submission.** They are inferred from task keys, so they are never
  resubmitted wholesale; `features` supplies names and acceptance criteria by id, and omitting one
  leaves it alone.
- **`baseRevision` guards every write.** A stale revision is rejected, so parallel workers can't
  clobber each other.
- **Unknown fields survive.** An update merges onto the stored task, so `difficulty`, `modelHint`,
  `criteria` and anything added later are never silently dropped.
- **The dependency graph stays sane.** Cycles and dangling references are rejected at write time; a
  task can't be `complete` while something it depends on isn't.

## Watching it work

**In the terminal** — the widget above updates on every turn, showing all five levels of the plan:
goal, sprint, feature, task, subtask. It is a *window*, not a truncation — the rows above and
below are counted, and one keypress away:

| Key | |
|---|---|
| `alt+j` / `alt+k` | scroll the plan down / up |
| `alt+o` | expand — every subtask, three times the rows |
| `/infinity:scroll follow` | back to tracking the active task |

It is responsive down to ~58 columns, degrades to ASCII when the locale isn't UTF-8, and drops
colour under `NO_COLOR`.

**In a browser** — `/infinity:dashboard` serves a live page on loopback: phase rail, stacked progress
meters that show stuck work as colour rather than absence, the whole plan as a collapsible
goal → sprint → feature → task → subtask tree with counts at every level, and the last gate
verdict. It refreshes itself every 5 seconds and reconnects with backoff if the run ends.

The dashboard is strictly read-only and binds to `127.0.0.1`. It never writes, and never bumps
`baseRevision` — opening it can't perturb the run you're watching.

## Craft skills

28 short documents on how to do the work well — how to write a test worth
keeping, how to debug something intermittent, how to design a module boundary.
They ship with the package, so pi loads them wherever it's installed and the
model can invoke any of them by name.

A model with 28 skills available and no idea which one applies reads none of
them, so **the brief names the ones that match the work in hand**. Each skill
declares what it's for:

```yaml
kind: domain                                     # process | domain | meta
phases: [plan, build, verify]                    # the phase it leads counts most
tags: [concurrency, race, lock, mutex, deadlock] # vocabulary a task would use
```

A `process` skill belongs to its phase — TDD is the right answer for a BUILD
task whatever the task says. A `domain` skill has to share vocabulary with the
task: nobody needs the database skill because they happen to be in BUILD. So a
task called *"serialise plan writes so two workers can't race on the lock"*
gets `concurrency-async`, and a bare BUILD task gets `tdd`.

When nothing matches, the brief has no skills section. An empty section is
honest; a padded one teaches the model to skip it.

## Model routing (optional)

Send cheap tasks to a small model and hard ones to a large one. Pick them with `/infinity:config` →
**Models**: the list offered is the models **pi itself has configured and can authenticate**, so you
choose from what you already have rather than typing ids from memory. `/infinity:models` shows that
list alongside the current routing.

Routing ships **disabled with every slot empty**, meaning "use whatever model pi is already
configured with" — installing the harness never silently redirects your work to someone else's
model. Any tier can be handed back to that default at any time.

Resolution order:

```
task.modelHint → byTask → byDifficulty → byFeature → bySprint → byPhase → byRole → default
```

`master` is never assigned directly; it's reachable only through one-step consultation after the
normal ladder is exhausted.

**Reasoning models need headroom.** A reasoning model emits nothing on the content channel until it
has finished thinking — measured at ~370 reasoning tokens to answer "reply with one word". If you
route a tier to one, give its workers a generous timeout; a tight budget returns an empty completion
that looks like a broken endpoint but is only a small cap.

## Tools the agent gets

| Tool | Purpose |
|---|---|
| `infinity_init` | Create the harness in this project |
| `infinity_brief` | What am I supposed to be doing right now? |
| `infinity_plan` | Read or rewrite the plan — tasks, features, criteria, goal |
| `infinity_validate` | Run the gate for this phase |
| `infinity_advance` | Move to the next phase (refuses on a failing gate) |
| `infinity_dashboard` | Start/stop/query the web view |
| `infinity_unstuck` | What should I try next? (recommends; does not act) |
| `infinity_rework` | Send a task and its dependents back to rework |
| `infinity_replan` | Add what the plan was missing, mid-run |
| `infinity_spawn_worker` | Attempt one task in a clean-room worker |
| `infinity_goal` | State a goal, review it, or check which pass it is on |

## Layout

```
infinity-harness/
├── extensions/infinity-harness/   pi lifecycle adapter — thin, no logic of its own
├── src/
│   ├── core/                      types · paths · fsx · config · phases · gates · brief
│   │                              · featureList (the SSOT) · lock · exec
│   │                              · skills (match) · skillsAudit (guard)
│   ├── ui/                        theme · planTree (the five levels, once)
│   │                              · widget (terminal) · dashboard (web) · wizard · config
│   ├── loop.ts                    the continuous-run driver and its stop conditions
│   ├── runState.ts                is a run armed, and which run is it — on disk, across sessions
│   ├── handoff.ts                 when to continue in a fresh session, and what to tell it
│   ├── approval.ts · intake.ts    human sign-off · what the start-up wizard's answers mean
│   ├── escalate.ts                the ladder's actuator: chooses a rung and takes it
│   ├── goal.ts                    the outer loop: is the thing asked for actually done?
│   ├── taskList.ts                atomic plan editor
│   ├── worker.ts                  isolated per-task workers
│   ├── modelRouter.ts             difficulty ladder + consultation
│   ├── rework.ts · replan.ts      backward rework with BFS impact · mid-build amendment
│   ├── unstuck.ts · review.ts     escalation strategy matrix · review bounce guard
│   └── goalLoop.ts · goalState.ts · goalSpec.ts   goal state machine and its store
├── harness/
│   ├── features/feature-list.json the plan
│   ├── config.json                pipeline state and settings
│   ├── run.json                   the armed run — survives every session it spans
│   ├── model-router.json          optional routing
│   ├── docs/                      architecture · decisions · phase and role docs
│   └── skills/                    28 craft skills the brief points at
├── tests/                         31 files, plain node:assert
└── scripts/
    ├── run-tests.mjs
    ├── e2e.mjs                    16 scenarios, including one against a real pi process
    └── rig/                       the real-pi driver: a scripted model + the RPC protocol
```

The extension is deliberately thin. Every decision lives in `src/`, where it's typed and tested —
there is one implementation, and the adapter calls it.

## Development

```bash
npm install
npm run check                    # tsc --noEmit, strict
npm test                         # 31 test files
npm run e2e                      # 16 end-to-end scenarios
npm run e2e -- --only realpi     # just the ones that drive a real pi process
npm run e2e -- --list            # what the scenarios are
```

Tests are plain `node:assert` run under `--experimental-strip-types`. No framework, no build step.

The scenario worth knowing about is **`realpi`**. Everything else drives our own modules, or drives
the adapter against a *fake* pi — a fair test of our contracts and a poor test of pi's. Every bug
that has reached a user so far lived in the gap between the two: a BOM that made every config read
fail, a run that ended at its first session handoff, a brief queued in a delivery mode that
deadlocks `pi -p`.

`realpi` closes the gap. `scripts/rig/` starts a real `pi --mode rpc` against a scripted model
server and speaks the RPC protocol to it — typing prompts and slash commands, answering wizard
dialogs, and reading back the widget and notifications a human would actually see. It covers
startup, the wizard, a run spanning several real sessions, real auto-compaction, an approval
round-trip, and `pi -p` not hanging. When something is wrong in the product rather than in a
module, this is the scenario that notices.

## Licence

MIT
