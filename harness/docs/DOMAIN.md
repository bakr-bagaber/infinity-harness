# Domain Glossary

The project's ubiquitous language. One concept, one name — everywhere: spec, code, tests, docs.

## Terms

### Plan

The single source of truth on disk for what will be built. Canonical: `harness/plan.json` (legacy `harness/features/feature-list.json` still read/written). Structure: Goals → Sprints → Features → Tasks → Subtasks. Every task has `key`/`id`, `status`, `dependsOn`, `phase`; every feature has `criteria`. Grows via progressive expansion (one `A` worker seeds the next phase). Do not confuse with "plan file alias" — there is one plan.

### Phase

The gated pipeline: `research → define → plan → build → verify → simplify → review → ship`. Enabled by `config.phases.enabled`; progress and `decideNext` are phase-scoped; `isPhaseDone` includes the rework queue. Phases advance forward-only; backward movement is only via bounded rework/replan.

### Gate

Deterministic checks per phase (`src/core/gates.ts`). The only referee for phase advance. Advisory when unconfigured (never blocks). Decides pass/fail; the phase machine decides what happens next.

### BaseRevision

Optimistic-concurrency counter on the plan. Every mutating write of the plan via `taskList.writeTaskList` bumps it; a write presenting a stale revision is rejected. Held under `withLockSync` (`.ilock`, not `.lock`) so two parallel workers reading `N` do not both write `N+1` losing edits.

### Worker / Run / Unit

A *worker* is one background `pi --mode rpc` child process for one *unit* — goal, phase, sprint, feature, task or subtask as named by `session.handoff`. The *run* is the whole armed execution (`harness/run.json`). Workers write attempt history under `tmp/infinity-harness/<runId>/<feature>/<task>/attempt-N/` and are recorded with fingerprint (`baseRevision` + `featureListHash`). Parallel workers when `isolation=worktree`, each in its own git worktree.

### Daemon / Supervisor / Control Room

*Daemon* — detached `harness/daemon.json` owner (heartbeat 20s, stale 90s) + localhost server (port 0, token 0600). *Supervisor* — `harness/supervisor.json` + `activity.json` live worker + background log (the surfaces read). *Control Room* — the extension's UI is a thin viewer when the Daemon is live: it never renders a dead run as live, forwards throttle/approve/rework/replan to the Daemon, and respects the control-panel contract + `X` tripwire.

### Tier / Pilot / Mode

*Tiers* `A/B/C/D/X` in `config.tiers` — pure routing (difficulty → tier → `provider/id`); `X` is MASTER and is never directly assigned, only via one-step consultation ladder (`easy→moderate→difficult→MASTER`) when a fixup is needed. *Pilot* `copilot|autopilot|full` and *Mode* per-phase (`phaseModes`) decide whether a passing gate stops for a human signature.

### Limits / Budget / Recycle

*Limits* — `unitWallClockMs`, `maxRecycles`, `maxReworkPerUnit`, `maxReplansPerPhase`, caps. Guarded by `preflight` (tiers must serve one token) and `budget` (per-tier tokens/cost, `X` leak tripwire). *Recycle* — compaction recycles the worker (capped 2); `CredentialSynchronizationError` retries are not charged.

### Rework / Replan / Bounce / Unstuck

*Rework* — backward edge: BFS over `dependsOn` limited by `maxImpactDepth`, flips origin+impacted to `rework`/`pending` and records `harness/rework.json` return-to-origin. *Replan* — additive amendment (`harness/replan.json`) cancels (not deletes) with DAG validation, capped at 3 per phase. *Bounce* — review-phase `reviewBounce` flips to rework only when `fileDelta` + `bounceRequiresDelta`. *Unstuck* — orchestrator that tries strategies in `config.unstuck.strategies` order with fingerprint dedup, budgets, hysteresis and one-step-only master guard.

### Handoff / Escalate

*Handoff* — `session.handoff` granularity; when to start a fresh pi session (same unit keeps the session and the model). *Escalate* — the ladder the loop climbs on stalled failures; a model switch is a new worker session — session boundary = model boundary by construction.

### Brief / Widget / Dashboard

*Brief* — `src/core/brief.ts` “what do I do right now?” injected at session start and on phase change. *Widget* — terminal plan view; *Dashboard* — web view of the same state. Both include remote `router` + `rework` exposure (read-only, advisory).
