# Architecture — pi-harness v1.0 (F1: Visual 5-Level + baseRevision)

F1 ships the foundation for the Pi-native harness: a 5-level visual widget, atomic revisioned state, and compaction-safe replay. The enforcement layer reuses `dev-harness` `cli/lib/*` and adds Pi lifecycle hooks.

## Module Structure

Top-level layout mirrors the Pi package contract:

- `extensions/harness-enforcer/index.ts` — **core enforcement extension**. Subscribes to Pi events (`session_start`, `turn_end`, `tool_call`, `agent_start`/`agent_end`, `session_shutdown`, `session_before_compact`, `session_compact`, `context`). Registers `harness_task_list` tool, renders widget via `ctx.ui.setWidget`/`setStatus`, manages `harness:checkpoint` hidden injection, and guards `harness/config.json` hand-edits. Depends on `proper-lockfile`, `string-width`, dynamic import of `cli/lib/brief.mjs|gates.mjs|state.mjs|phases.mjs`.
- `src/widget.ts` — **pure rendering library** (no Pi deps). Exports `WIDGET_LIMIT=8`, `COMPLETED_CONTEXT=3`, `statusIcon`, `wrapWidgetLines`, `getWidgetWindowBounds`, `buildWidgetLines`, `formatDeps`, `createWidgetRenderer`. Ports `task-tracker/rendering.ts` + `pi-long-task` sidebar + `99people`/`rpiv` deps display. Tested via `tests/widget.test.ts`.
- `src/harnessTaskList.ts` — **atomic state engine**. Exports `atomicApply`, `ValidationError`, `harnessStateFromFile`, `fileFromHarnessState`, `applyToFile`, `loadHarnessState`, `saveHarnessState`. Implements `baseRevision` optimistic concurrency, omission=deletion, `dependsOn` cycle/missing checks, `in_progress`/`complete` requires deps `completed`, completed→completed pruning, and temp-file+rename atomic writes. Tested via `tests/harnessTaskList.test.ts`.
- `harness/features/feature-list.json` — **single source of truth (SSOT)**. Schema `harness/features/feature-list.schema.json` v1.0: top-level `baseRevision`, `goals[]`, `sprints[]`, `features[]` where each `feature.tasks[]` carries `key`, `dependsOn`, `subtasks[]`. `harness/` remains canonical; `pi.appendEntry` mirrors but never diverges.
- `harness/docs/*` — `ARCHITECTURE.md`, `DECISIONS.md`, `DOMAIN.md`, `CONSTRAINTS.md`, `agents/*.md`, `phases/*.md`.
- `tests/` — `widget.test.ts` (wrap vs truncate, window bounds, 5-level rendering, overflow, deps), `harnessTaskList.test.ts` (baseRevision, omission, cycle, deps, all-or-nothing, file persistence, replay).

## Data Flow

User intent (natural language plan) → LLM calls `harness_task_list({baseRevision, tasks})` → extension acquires `proper-lockfile` on `harness/features/feature-list.json`, loads current state via `harnessStateFromFile`, validates via `atomicApply`, derives `nextFile` via `fileFromHarnessState`, writes atomically (`write tmp + rename`), updates in-memory `harnessState` + `harnessFileSnapshot`, calls `ctx.ui.setWidget` with `buildWidgetLinesFromState`, returns `details: {rev, tasks, change}`. On compaction, `session_before_compact` stores hidden `harness:checkpoint` via `pi.appendEntry`; `context` re-injects it as `messages: [{role:"user", content:[{type:"text"}]}]` so the next turn sees exact `rev + keys` without extra turn. Periodic `harness:reminder` every 3 LLM calls keeps plan in context.

## Rendering Details

`buildWidgetLines` renders Goal → Feature → Sprint → Task → Subtask (5 levels). Uses `wrapWidgetLines(text, width)` with `string-width` for display width, hard-splits words longer than width, and preserves content (never ellipsis). Window: `getWidgetWindowBounds(items, WIDGET_LIMIT=8, COMPLETED_CONTEXT=3)` finds active index (`in_progress` → `pending` → `blocked` → tail), keeps 3 completed context, shifts to include `blockedBefore`, clamps. Output includes `Progress: x/y  Todos (x/y)`, `○●◐⚠↷` icons, `← #1` deps via `keyToIndex`, `+N more` overflow, indentation for subtasks.

## Concurrency & Persistence

Locking: `proper-lockfile` on `harness/features/feature-list.json` (retries 5, stale 8s) in `harness_task_list` and `agent_start`; file writes are temp-file + `renameSync` for atomicity. Revision: incremented only on real change (added/updated/removed/reordered); no-op preserves `baseRevision`. Omission: any current key absent from input is deleted; soft-prune removes `completed→completed` edges pointing at deleted completed tasks before missing-dep check.

## Trade-offs

Duplication between `src/` and `extensions/harness-enforcer/index.ts` is intentional for runtime isolation — the extension must run inside Pi without requiring a build step to bundle `src`. Recorded in `DECISIONS.md` (2026-08-21). Future work could extract `src/shared` and bundle via `tsup`/`esbuild` once Pi package bundling is adopted.

## Verification

`tcs --noEmit` clean, `node --experimental-strip-types tests/*.test.ts` passes (widget + atomic), feature list validates against `feature-list.schema.json`. Extension lifecycle manually verified via `pi -e ./pi-harness` (widget appears, survives `/reload`, branch replay via `toolResult.details`, compaction hidden checkpoint).
