# Changelog

All notable changes to `pi-harness` will be documented here.

## [0.4.0] - 2026-08-21

### Added
- **F3 Worker Isolation per BUILD Task:** `src/worker.ts` with `createWorkerRunDir`, `spawnIsolatedWorker`, `recordAttempt`, `buildFingerprint`, `hashLite`, `proper-lockfile` isolation on `harness/features/feature-list.json` + `harness/config.json`; attempt history to `tmp/pi-harness/<run-id>/<feature>/<task>/attempt-N/{prompt.md,output.log,fingerprint.json}` preserving `baseRevision` and 5-level fields; `tests/worker.test.ts` covering dir creation, `attempt-N` increment, `proper-lockfile` concurrent writes, `baseRevision` preservation, `fingerprint.json` validity and `tmp/pi-harness` isolation.
- `extensions/harness-enforcer` now exposes `harness_spawn_worker` hidden tool delegating to `src/worker.ts` `spawnIsolatedWorker` so `dev-harness run` isolates per BUILD task via `tmp/pi-harness/<run-id>/` without leaking `gateHistory` to the main session; extension stays `notify`+`appendEntry` only, no `sendUserMessage` mid-stream regression.
- `tmp/` ignored (`tmp/pi-harness/` worker attempt history does not dirty the repo).

## [0.3.0] - 2026-08-21

### Fixed
- **Enforcer stream race (F1 hotfix):** `turn_end` no longer calls `sendUserMessage`/`sendMessage` mid-stream — now `notify`+`appendEntry` only, avoiding OpenAI Responses stream ended error during `high` thinking turns.
- **BUILD gate infinite dirty:** untracked harness runtime state (`harness/config.json`, `feature-list.json`, `progress.md`, `session-handoff.md` now ignored) so `gateHistory` appends do not block `phase next`.

### Added
- **F2 Enforcer Auto-Loop Hardening:** `session_start` auto-inject lightweight (`notify`+`widget`), `context` hidden checkpoint and periodic reminder every 3 calls, `session_before_compact` `appendEntry` checkpoint, `tool_call` guard blocks phase-skip without `PASS`, `high` not `xhigh` for `dev-harness run` workers.

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
