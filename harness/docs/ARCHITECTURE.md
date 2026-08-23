# Architecture

infinity-harness is a pi extension that drives an agent through a gated build pipeline and keeps it
going, unattended, for hours or days.

The whole design rests on one idea: **take two decisions away from the model.** When work is done is
decided by a deterministic gate, not the agent's judgement. What happens next is decided by a
forward-only phase machine, not the agent's preference. Everything else exists to keep those two
decisions honest across a very long run.

## Shape

```
                        ┌──────────────────────────────────┐
   pi lifecycle ──────► │ extensions/infinity-harness      │   thin adapter
                        │ hooks · tools · commands         │   no logic of its own
                        └───────────────┬──────────────────┘
                                        │
        ┌───────────────────────────────┼───────────────────────────────┐
        ▼                               ▼                               ▼
   ┌─────────┐                   ┌─────────────┐                 ┌───────────┐
   │ loop.ts │                   │  taskList   │                 │    ui/    │
   │ decide  │                   │  atomic     │                 │ widget    │
   │ next    │                   │  plan edit  │                 │ dashboard │
   └────┬────┘                   └──────┬──────┘                 └─────┬─────┘
        │                               │                              │
        └───────────────┬───────────────┴──────────────────────────────┘
                        ▼
              ┌───────────────────────────────────────────────┐
              │ src/core/                                     │
              │ types · paths · fsx · lock · exec             │
              │ config · phases · gates · brief · featureList  │
              └───────────────────────┬───────────────────────┘
                                      ▼
                            harness/  (state on disk)
                            config.json · features/feature-list.json
```

**The extension is thin on purpose.** An earlier version inlined its own copies of the plan engine
and the widget, so the tested code and the shipped code were two different implementations that
drifted apart. There is one implementation now, in `src/`, and the adapter calls it. The same rule
applies to every module: if you find yourself writing a private `loadFeatureList`, stop — that
mistake has already been made twice and fixed twice.

## Layers

### `src/core/` — owned foundations

| Module | Responsibility |
|---|---|
| `types.ts` | Every shape crossing a module boundary. No I/O; safe to import anywhere. |
| `paths.ts` | The only place a `harness/…` path is spelled out. |
| `fsx.ts` | Atomic JSON writes, `.bak` snapshots, absent-vs-corrupt reads. |
| `exec.ts` | Every shell-out, bounded by a timeout. Never throws; failures are data. |
| `lock.ts` | `withLockSync` (exclusive, fail-closed) and `withLock` (advisory, best-effort). |
| `config.ts` | `harness/config.json` — pipeline state, retry budgets, gate history. |
| `phases.ts` | The forward-only state machine and `transitionPhase`. |
| `gates.ts` | The deterministic checks and the runner. |
| `featureList.ts` | The plan on disk: load, save, flatten, progress, dependency integrity. |
| `brief.ts` | "What do I do now?", assembled from state and rendered for a model. |

These were ported to TypeScript from a sibling CLI project that used to be reached through a symlink.
The symlink made the package unshippable — it pointed at an absolute path on one developer's
machine — so the needed logic is now owned, typed, and tested here.

### `src/` — the harness proper

- **`taskList.ts`** — the atomic plan editor. The agent submits the complete list; omission means
  deletion; `baseRevision` guards the write; unknown fields survive.
- **`loop.ts`** — `decideNext()`: given state on disk, continue, advance, wait, or stop.
- **`worker.ts`** — isolated per-task workers under `tmp/infinity-harness/<run>/`.
- **`modelRouter.ts`** — optional difficulty ladder, disabled and vendor-neutral by default.
- **`rework.ts` / `replan.ts`** — bounded backward movement: BFS impact analysis, DAG-guarded
  mid-build amendment.
- **`unstuck.ts` / `review.ts`** — escalation strategy matrix; the REVIEW bounce guard.
- **`remote.ts`** — the read-only dashboard server.

### `src/ui/` — the visible surface

- **`theme.ts`** — ANSI-aware width, wrapping, truncation, colour degradation, glyph fallback.
- **`widget.ts`** — the terminal plan view.
- **`dashboard.ts`** — the web plan view, same information design.

## Data flow

```
session_start ──► buildBrief ──► renderBrief ──► sendMessage        the agent is told what to do
                     ▲
                     │
agent works ─────────┼──► infinity_plan ──► writeTaskList ──► feature-list.json
                     │                          (locked)              │
                     │                                                ▼
agent_settled ──► decideNext ──► runChecks ──► gate verdict      widget · dashboard
                     │                │
                     │                ├── pass ──► advancePhase ──► new brief ──► next turn
                     │                └── fail ──► re-brief with the failing checks
                     │
                     └── budgets exhausted / no progress / paused ──► stop, with a reason
```

Nothing caches a second copy of the plan. The widget, the dashboard and the brief all read
`feature-list.json`, so the visible state is always the real state — even when the agent's own
narration has drifted.

## Concurrency

Parallel workers write the same plan file. `baseRevision` detects a stale **read**; it cannot
serialise a read-modify-write. Two processes that both read revision N both pass the check and both
write N+1, and one set of edits is gone — measured at 2 lost updates in a 6-way fan-out.

So `writeTaskList` holds an exclusive lock across the entire read-apply-write, and **fails closed**:
if the lock cannot be taken, the write is refused with an error the caller can retry, rather than
racing and losing an edit silently.

Two details that cost real debugging time:

- The sync lock uses `<path>.ilock`, **not** `<path>.lock` — the latter is what `proper-lockfile`
  uses, and it is a directory there too. Sharing the name made a nested async+sync lock deadlock
  against itself.
- Locks are held for the duration of the *work*, never across an agent turn. An earlier version took
  a lock at the start of a turn with an 8-second staleness timeout, so every turn longer than eight
  seconds left a lock another process was entitled to steal.

## Stopping

Continuing is easy; knowing when to stop is the hard part, and the difference between a useful
overnight run and a wasted weekend of tokens.

| Guard | Catches |
|---|---|
| No-progress detector | The gate keeps failing and the tree fingerprint hasn't moved — spinning, not working |
| Wall clock | A run nobody remembered to stop |
| Iteration ceiling | Runaway loops that stay under the clock |
| Retry budgets | One impossible task consuming the run |
| Human brake | `paused`, `/infinity:halt`, or `harness/STOP` |

The fingerprint is `git status --porcelain` + HEAD + the plan revision and task statuses. The first
failing iteration establishes a baseline and never counts as a stall — there is nothing to compare
against yet.

Every stop carries a reason. A human coming back finds an explanation, not a mystery.

## Failure posture

- **Reads distinguish absent from corrupt.** A missing plan seeds an empty one; a corrupt plan
  recovers the previous good revision from `.bak` rather than silently starting over.
- **Advisory checks never fail a gate.** A gate that fails for a reason the agent cannot fix
  deadlocks the loop, so an unconfigured lint command is reported, not enforced.
- **Errors are data where the caller can continue** (`{ ok, error }`), thrown where it cannot.
- **The dashboard cannot perturb the run.** Read-only, loopback-only, and it never runs the gate —
  running lint and tests because someone opened a web page would be a surprising side effect.

## Verification

- `npm test` — 20 unit files, plain `node:assert`, no framework.
- `npm run e2e` — 11 scenarios over real temp projects, real git repos, real child processes: the
  full pipeline walkthrough, loop convergence, every stop condition, SIGKILL-and-restart, a 6-way
  concurrent write fan-out with an unlocked control, data round-trip, the dashboard, widget
  rendering across shapes, adversarial input, and the extension adapter itself.
