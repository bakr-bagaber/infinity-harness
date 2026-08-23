---
name: pi-todo-adapted
description: "Atomic infinity_plan pattern with omission deletion, baseRevision optimistic concurrency, cycle/missing-dep checks and compaction-safe replay (adapted from @99percentpeople/pi-todo)"
tags: [harness, pi-todo, atomic, baseRevision, omission, deletion, compaction, widget, task-list, dependency]
when: "implementing infinity_plan, atomic revisioning, Pi widget with session persistence or task dependencies"
phases: [build, verify]
provenance: { origin: "https://github.com/99percentpeople/pi-extensions", license: MIT, adapted: true, url: "https://github.com/99percentpeople/pi-extensions", contentHash: abf626df6a74a6fb }
---

# pi-todo Adapted — Atomic Task List with Compaction-Safe Replay

> Adapted from [@99percentpeople/pi-todo](https://github.com/99percentpeople/pi-extensions) (MIT © 99percentpeople). Trimmed to harness core and re-pointed to `harness/features/feature-list.json` + Pi extension `harness:checkpoint`.

## Rules

- **One-call authoritative list.** Client sends complete desired list; server treats omission as permanent deletion. Inherit omitted fields from previous snapshot; new keys require `subject` + `status`. Validation all-or-nothing.
- **Optimistic concurrency via baseRevision.** Compare `input.baseRevision` vs current `revision`; reject stale with expected/current numbers; increment revision only on real change; empty no-op preserves revision.
- **Dependency guarantees.** Every `dependsOn` must exist in resulting snapshot (prune completed→completed soft refs only); detect cycles via DFS; `in_progress`/`completed` requires deps completed. Reject atomically.
- **ToolResult.details is SSOT for branch/compaction.** Store `{rev, tasks}` in toolResult.details; reconstruct state by scanning session branch for latest valid entry on `session_start`, `session_tree`, `/reload`. Branch-aware replay — each branch has correct snapshot.
- **Hidden checkpoint for compaction.** On `session_before_compact`, persist `{rev, tasks}` as custom entry `harness:checkpoint` outside context; inject as hidden `[{role:"user", content:[{type:"text", text: hidden}]}]` via `context` event on next prompt (or immediately as steer if overflow/continuation). No extra model turn.
- **Periodic hidden reminder.** Every N LLM calls (default 3) inject compact reminder with `rev + key/status` list via `context` event; reset counter after successful write, restoration, checkpoint injection, or interval change; suppress for empty/completed plans; not written to session.
- **Widget renders collapsed window via getWidgetWindowBounds.** Use WIDGET_LIMIT=8, COMPLETED_CONTEXT=3, `+N more`, wrap not truncate, `← #1` deps. State comes from reconstructed session + file; survive /reload and /tree.

## Anti-patterns

- **Per-field patch calls** — one call must carry full authoritative list; piecemeal updates lose atomicity.
- **File-only persistence** — file is SSOT but session replay is required for branches/compaction; without details replay, `/tree` drifts.
- **Eager completed cleanup without dependency check** — completed tasks that still block pending/in_progress must be retained.
- **Stale revision retry without re-read** — on stale error, re-read current rev/tasks and retry merge.

## Checklist

- [ ] Stale baseRevision rejected with expected/current message, no mutation
- [ ] Omitted keys deleted, completed→completed deps pruned, new keys validated
- [ ] Cycle and missing dep rejected atomically
- [ ] in_progress requires deps completed (also completed requires deps completed if strict)
- [ ] Revision increments only on added/updated/removed/reordered; details contain {rev, tasks}
- [ ] State replays from toolResult.details + harness:checkpoint on session_start / session_tree
- [ ] Hidden checkpoint stored before compaction and injected via context event after compaction
- [ ] Periodic reminder every 3 calls injects rev + key/status via context, counter resets correctly
- [ ] Widget uses rolling window (WIDGET_LIMIT=8) with +N more, wraps long labels, shows ← #1
