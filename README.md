# pi-harness

> **Pi-native enforcement layer for `dev-harness`.** The harness loop is now automatic — Pi injects the brief, validates, and advances phases without the agent deciding to.

This is the successor to `dev-harness-pi` v1 (which only wrapped CLI as `/harness:*` commands). `pi-harness` makes the pipeline **enforced, autonomous, and continuous**.

## Quick Start

```bash
# 1. Install the package (project-local, so team shares it via .pi/settings.json)
pi install ./pi-harness -l

# Or global
pi install ./pi-harness

# Verify
pi list

# 2. Open a project that has a harness/
pi
# → session_start auto-injects: "═══ NEXT STEP · BUILD · feature-001 · task-001 ═══ ..."

# 3. Do the work, then just stop talking — turn_end auto-validates and auto-advances
# No manual /harness:next, /harness:validate, /harness:phase next needed (but they still work as escape hatches)

# 4. For continuous multi-day runs
pi --loop
```

## What Changed vs v1

| v1 (`dev-harness-pi`) | v2 (`pi-harness`) |
|---|---|
| `/harness:next` must be typed by agent/human | `session_start` **auto-injects** brief |
| `validate`/`phase next` manual | `turn_end` **auto-runs** validate → phase next |
| No guard on `harness/config.json` hand-edits | `tool_call` interceptor **blocks** skipping |
| Multi-agent corrupts `harness/` | File lock on `harness/config.json` |
| Stops when turn ends | `session_shutdown` **auto-resumes** for continuous dev |

## Project Status

- **Phase:** SHIP — v1.1.0 F6 Resilient Self-Correction shipped (model-router + rework↷ + replan + unstuck matrix + review bounce + remote router/rework)
- **Source harness:** `~/ops/Projects/dev-harness` (v5.1.0)
- **Pi docs:** `extensions.md`, `sessions.md`, `packages.md`
- **Harness state:** `harness/features/feature-list.json` (SSOT, `baseRevision:2`, `goals`/`sprints` + `key`/`dependsOn`/`subtasks` + `difficulty`/`modelHint` + `status: rework`)
- **Architecture:** `harness/docs/ARCHITECTURE.md` · Decisions: `harness/docs/DECISIONS.md` · Rubric: `harness/evaluator-rubric.md` (9/12 — revise, F1 baseline; update to v1.1.0 pending)

See `SPEC.md` for full requirements, `pi-harness.md` for folder note, and `harness/docs/ARCHITECTURE.md` for module structure.

## Development

```bash
cd ~/ops/Projects/pi-harness
npm install
npm run build   # tsc
npm run check   # tsc --noEmit
npm run lint
```

## Structure

```
pi-harness/
├── pi-harness.md                    # Folder note
├── SPEC.md                          # Requirements (F1-F6)
├── README.md                        # This file
├── src/
│   ├── widget.ts                    # 5-level rendering (statusIcon, wrapWidgetLines, getWidgetWindowBounds, buildWidgetLines) + rework ↷
│   ├── harnessTaskList.ts           # Atomic engine (baseRevision, omission=deletion, cycle/deps, file helpers) + rework status
│   ├── worker.ts                    # Worker isolation + per-task model injection
│   ├── goalSpec.ts                  # GOAL_SPEC schema + markdown
│   ├── goalLoop.ts                  # Goal loop state machine + reviewer model routing
│   ├── goalState.ts                 # Canonical + run-scoped goal persistence
│   ├── remote.ts                    # Read-only HTTP view (127.0.0.1:0, router/rework)
│   ├── modelRouter.ts               # Difficulty ladder + MASTER one-step consultation
│   ├── rework.ts                    # Backward rework with BFS impact + rework.json
│   ├── replan.ts                    # Mid-BUILD plan amendment with DAG guards
│   ├── unstuck.ts                   # Unstuck strategy matrix with budgets/dedup/hysteresis
│   └── review.ts                    # REVIEW bounce guard
├── tests/
│   ├── widget.test.ts               # Wrap vs truncate, window, 5-level, Progress, ← #1, +N more
│   ├── harnessTaskList.test.ts      # Atomic, file persistence, replay
│   ├── worker.test.ts               # Isolation + model fingerprint
│   ├── remote.test.ts               # BuildRemoteState + ephemeral read-only server
│   ├── goalSpec.test.ts             # GOAL_SPEC create/validate/markdown
│   ├── goalLoop.test.ts             # Loop lifecycle + reviewer
│   ├── goalState.test.ts            # GoalStateStore persistence
│   ├── modelRouter.test.ts          # Ladder, MASTER never assigned, priority, fresh-read
│   ├── rework.test.ts               # BFS, flip, bump, history, guard
│   ├── replan.test.ts               # DAG guards, maxReplans
│   ├── unstuck.test.ts              # Order, budgets, fileDelta, dedup, hysteresis
│   └── review.test.ts               # bounceRequiresDelta, maxBounces, fresh-read
├── harness/
│   ├── docs/ARCHITECTURE.md         # Module structure + data flow (v1.1.0)
│   ├── docs/DECISIONS.md            # 8 accepted decisions (F1-F6)
│   ├── features/feature-list.json   # SSOT (baseRevision, goals, sprints, features/tasks/subtasks)
│   ├── model-router.json            # Router v1 (optional, fresh-read, bundled)
│   └── evaluator-rubric.md          # Review scores (F1 9/12 baseline)
├── extensions/harness-enforcer/
│   └── index.ts                     # Pi enforcement (lifecycle, tools, widget, checkpoint, lock, routing)
├── harness/model-router.json        # Default router v1 (disabled, safe defaults)
├── skills/                          # Re-exported craft skills (29)
├── prompts/                         # Re-exported prompts
└── package.json                     # pi manifest (1.1.0)
```

## F6 — Resilient Self-Correction (v1.1.0)

All optional, bounded, and read fresh each call — no endless loops:

- `harness/model-router.json` v1 — ladder `easy→moderate→difficult→MASTER` (MASTER never assigned, one-step consultation only), `resolveModel` priority `task.modelHint > byTask > byDifficulty > byFeature > bySprint > byPhase > byRole > default`
- `src/rework.ts` / `harness/rework.json` — `startRework` BFS impact (depth 3), flips to `rework` `↷`, bumps `baseRevision`, return-to-origin record
- `src/replan.ts` / `harness/replan.json` — `amendPlan` with DAG guards, `maxReplansPerRun 2`
- `src/unstuck.ts` — `chooseUnstuckStrategy` matrix `retry→reframe→consult→rework→replan→master` with budgets, fingerprint dedup, `fileDelta` guard, hysteresis
- `src/review.ts` — `shouldBounceToRework` (`allowBackward`, `maxBounces 2`, `bounceRequiresDelta`)
- Budgets: `maxReworks 3`, `maxReplans 2`, `maxBounces 2`, `maxPerTask 1` + `hashLite` dedup + `bounceRequiresDelta` + `hysteresisMs`
- Remote read-only: `GET /api/harness` exposes `router` + `rework` without bumping `baseRevision`
