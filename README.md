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

- **Phase:** REVIEW → SHIP (F1 Visual 5-Level Widget + baseRevision complete — `baseRevision`, `harness_task_list` atomic + compaction checkpoint, 5-level widget verified; pending changelog/tag)
- **Source harness:** `~/ops/Projects/dev-harness` (v5.1.0)
- **Pi docs:** `extensions.md`, `sessions.md`, `packages.md`
- **Harness state:** `harness/features/feature-list.json` (SSOT, `baseRevision:2`, `goals`/`sprints` + `key`/`dependsOn`/`subtasks`)
- **Architecture:** `harness/docs/ARCHITECTURE.md` · Decisions: `harness/docs/DECISIONS.md` · Rubric: `harness/evaluator-rubric.md` (9/12 — revise)

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
├── SPEC.md                          # Requirements (F1-F5)
├── README.md                        # This file
├── src/
│   ├── widget.ts                    # 5-level rendering (statusIcon, wrapWidgetLines, getWidgetWindowBounds, buildWidgetLines)
│   └── harnessTaskList.ts           # Atomic engine (baseRevision, omission=deletion, cycle/deps, file helpers)
├── tests/
│   ├── widget.test.ts               # Wrap vs truncate, window, 5-level, Progress, ← #1, +N more
│   └── harnessTaskList.test.ts      # Atomic, file persistence, replay
├── harness/
│   ├── docs/ARCHITECTURE.md         # Module structure + data flow
│   ├── docs/DECISIONS.md            # 5-level schema, checkpoint, duplication trade-off
│   ├── features/feature-list.json   # SSOT (baseRevision, goals, sprints, features/tasks/subtasks)
│   └── evaluator-rubric.md          # Review scores (9/12)
├── extensions/harness-enforcer/
│   └── index.ts                     # Pi enforcement (lifecycle, tool, widget, checkpoint, lock)
├── skills/                          # Re-exported craft skills (29)
├── prompts/                         # Re-exported prompts
└── package.json                     # pi manifest
```
