# Changelog

All notable changes to `pi-harness` will be documented here.

## [0.2.0] - 2026-08-21

### Added
- **F1 Visual 5-Level Widget + baseRevision** — Pi TUI now shows `Goal → Feature → Sprint → Task → Subtask` with rolling window (`WIDGET_LIMIT=8`, `COMPLETED_CONTEXT=3`), `+3 more` overflow, `← #1` dependency numbers, and `Progress: x/y`.
- `harness/features/feature-list.json` extended to 5 levels: `baseRevision`, `goals[]`, `sprints[]`, `tasks[].key`/`dependsOn`/`subtasks[]` with JSON schema validation.
- `src/widget.ts` ported from `task-tracker` + `pi-long-task` (status icons `○●◐⚠↷`, section headers `▸ Feature`).
- `harness_task_list` tool skeleton with `baseRevision` optimistic concurrency placeholder (full atomic + hidden `harness:checkpoint` for compaction lands in v0.3.0).

### Fixed
- `pi-harness` enforcer `session_start` lightweight + `context` injection to avoid `already processing` during `dev-harness run` preflight.

## [0.1.0] - 2026-08-20
- Initial clean port from `dev-harness` `5.1.0` — `cli`/`skills`/`prompts` via symlink, `extensions/harness-enforcer` with `session_start`/`turn_end`/`tool_call`/`proper-lockfile`.
