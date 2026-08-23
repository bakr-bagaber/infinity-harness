# infinity-harness

**A pi extension that keeps an agent building — correctly — for hours or days without you.**

Point it at a project, describe the goal, and walk away. infinity-harness drives the agent through a
gated pipeline, checks the work with deterministic gates rather than the model's own judgement, and
stops with a clear reason when it genuinely needs you.

```
╭──────────────────────────────────────────────────────────────────────────╮
│ ∞ INFINITY ──────────────────────────────────────────────── BUILD rev 42 │
│ ▸ Ship the payments rewrite behind a flag                                │
│                                                                          │
│ ● define ─ ● plan ─ ◉ BUILD ─ ○ verify ─ ○ review ─ ○ ship               │
│                                                                          │
│ ▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱  45%                  5/11 tasks · 1/2 features │
│ ⚠ 1 blocked · ↷ 1 rework · retry 2/10                                    │
│                                                                          │
│ ▸ feature-002 · Checkout flow                                            │
│   ●  4 validate cart totals against catalogue prices                     │
│   ●  5 apply stacked discount codes with precedence rules           ← #4 │
│   ◐  6 handle partial refunds across split tenders              ← #4, #5 │
│        ✓ unit tests for tender split                                     │
│        ▸ integration test against sandbox                                │
│        · audit log entries                                               │
│   ○  7 emit refund webhook                                          ← #6 │
│   ⚠  8 reconcile ledger nightly                                     ← #6 │
│   ⋯ 3 more                                                               │
╰──────────────────────────────────────────────────────────────────────────╯
```

---

## Why it exists

Left alone, a coding agent drifts. It declares work finished that isn't, forgets what it already
did, re-solves the same problem three different ways, and — worst of all — keeps going long after it
stopped making progress. Pair it with a small or cheap model and all of that gets worse.

infinity-harness fixes that by taking two decisions away from the model:

1. **When work is done.** A deterministic gate decides, not the agent. Same tree, same verdict, every
   time. No agent marks its own homework.
2. **What happens next.** The phase pipeline is forward-only and one step at a time. The agent cannot
   decide it's bored of BUILD and jump to SHIP.

Everything else — the plan, the retries, the model routing — exists to keep those two decisions
honest over a very long run.

## Install

Requires **Node 22+** and [pi](https://github.com/earendil-works/pi-coding-agent).

```bash
# project-local, so the whole team shares it via .pi/settings.json
pi install ./infinity-harness -l

# or globally
pi install ./infinity-harness

pi list   # confirm it loaded
```

## Use it

```bash
cd your-project
pi
```

On session start the harness injects a brief — phase, role, current task, acceptance criteria, and
what to do next. Do the work, then:

```
/infinity:validate     run the gate for this phase
/infinity:run          hand it the wheel: validate → advance → re-brief, until done or stuck
/infinity:dashboard    open the live web view
/infinity:halt         take the wheel back
```

`/infinity:run` is the point of the tool. It keeps the loop turning without you.

## The pipeline

```
define → plan → build → verify → [simplify] → review → ship
```

| Phase | What it's for | Gate opens when |
|---|---|---|
| **define** | Write down what's being built and how you'll know it's done | Every feature has acceptance criteria |
| **plan** | Break features into ordered, dependency-aware tasks | Tasks exist and criteria are set |
| **build** | Implement, one task at a time, tests alongside | Lint, tests, coverage pass; no placeholders; every task complete |
| **verify** | Prove behaviour; hunt what the tests miss | Tests and coverage pass on a clean tree |
| **simplify** | Delete more than you add *(opt-in)* | Tests pass, no empty dirs, clean tree |
| **review** | Judge it as if someone else wrote it | Rubric, README, architecture doc and decisions are real; branch level with upstream |
| **ship** | Tag, changelog, leave it clean | Clean tree, tagged, changelog, README, licence, no placeholders |

Enable or disable phases in `harness/config.json` under `phases.enabled`. SIMPLIFY is off by default.

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

- **Omission means deletion.** One unambiguous rule beats incremental edits a model loses track of.
- **`baseRevision` guards every write.** A stale revision is rejected, so parallel workers can't
  clobber each other.
- **Unknown fields survive.** An update merges onto the stored task, so `difficulty`, `modelHint`,
  `criteria` and anything added later are never silently dropped.
- **The dependency graph stays sane.** Cycles and dangling references are rejected at write time; a
  task can't be `complete` while something it depends on isn't.

## Watching it work

**In the terminal** — the widget above updates on every turn. It's responsive down to ~58 columns,
degrades to ASCII when the locale isn't UTF-8, and drops colour under `NO_COLOR`.

**In a browser** — `/infinity:dashboard` serves a live page on loopback: phase rail, stacked progress
meters that show stuck work as colour rather than absence, the full task tree, and the last gate
verdict. It refreshes itself every 5 seconds and reconnects with backoff if the run ends.

The dashboard is strictly read-only and binds to `127.0.0.1`. It never writes, and never bumps
`baseRevision` — opening it can't perturb the run you're watching.

## Model routing (optional)

`harness/model-router.json` can send cheap tasks to a small model and hard ones to a large one. It
ships **disabled with every slot empty**, meaning "use whatever model pi is already configured with" —
installing the harness never silently redirects your work to someone else's model.

Set `enabled: true` and fill in the ids you want. Resolution order:

```
task.modelHint → byTask → byDifficulty → byFeature → bySprint → byPhase → byRole → default
```

`master` is never assigned directly; it's reachable only through one-step consultation after the
normal ladder is exhausted.

## Tools the agent gets

| Tool | Purpose |
|---|---|
| `infinity_brief` | What am I supposed to be doing right now? |
| `infinity_plan` | Read or rewrite the task list |
| `infinity_validate` | Run the gate for this phase |
| `infinity_advance` | Move to the next phase (refuses on a failing gate) |
| `infinity_dashboard` | Start/stop/query the web view |

## Layout

```
infinity-harness/
├── extensions/infinity-harness/   pi lifecycle adapter — thin, no logic of its own
├── src/
│   ├── core/                      types · paths · fsx · config · phases · gates · brief
│   │                              · featureList (the SSOT) · lock · exec
│   ├── ui/                        theme · widget (terminal) · dashboard (web)
│   ├── loop.ts                    the continuous-run driver and its stop conditions
│   ├── taskList.ts                atomic plan editor
│   ├── worker.ts                  isolated per-task workers
│   ├── modelRouter.ts             difficulty ladder + consultation
│   ├── rework.ts · replan.ts      backward rework with BFS impact · mid-build amendment
│   ├── unstuck.ts · review.ts     escalation strategy matrix · review bounce guard
│   └── goalLoop.ts · goalState.ts · goalSpec.ts
├── harness/
│   ├── features/feature-list.json the plan
│   ├── config.json                pipeline state and settings
│   ├── model-router.json          optional routing
│   ├── docs/                      architecture · decisions · phase and role docs
│   └── skills/                    29 craft skills the brief points at
├── tests/                         20 files, plain node:assert
└── scripts/run-tests.mjs
```

The extension is deliberately thin. Every decision lives in `src/`, where it's typed and tested —
there is one implementation, and the adapter calls it.

## Development

```bash
npm install
npm run check    # tsc --noEmit
npm test         # 20 test files
npm run e2e      # end-to-end against a live model
```

Tests are plain `node:assert` run under `--experimental-strip-types`. No framework, no build step.

## Licence

MIT
