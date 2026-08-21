# Sprint Contract — pi-harness F3 v0.4.0

## Scope (Generator proposes)

**I will build:**
F3 Worker Isolation per BUILD Task (v0.4.0). Add `src/worker.ts` with `createWorkerRunDir`, `spawnIsolatedWorker`, `recordAttempt`, attempt history to `tmp/pi-harness/<run-id>/<featureId>/<taskId>/attempt-N/{prompt.md, output.log, fingerprint.json}` using `proper-lockfile` on `harness/features/feature-list.json` and `harness/config.json`. Wire `extensions/harness-enforcer/index.ts` to stay notify-only but expose worker helper so `dev-harness run` isolates per task via `tmp/pi-harness/<run-id>/` and `gateHistory` does not leak. Keep `dev-harness run` driver loop (git `run/<id>` branch + `--thinking high` + no `-e`) and 5-level widget intact. Port dummy harness loop concept from `/tmp/pi-harness-dummy` (fresh `pi --print` per task with isolated prompt).

**I will NOT build:**
Goal loop `GOAL_SPEC.json` + reviewer worker (F4), Remote web view `/pi-harness:remote` QR push (F5), new harness phases or gates beyond `define`→`ship`, `pi --loop` daemon beyond per-task isolation.

## Verification Criteria (Generator proposes)

1. `npx tsc --noEmit` passes; `src/worker.ts` exists with worker-dir and isolation helpers and unit tests `tests/worker.test.ts` passing (create dir, record attempt, lock, baseRevision preserved, fingerprint).
2. Fresh `pi --print` per BUILD task demonstrated: worker run writes `tmp/pi-harness/<run-id>/<feature>/<task>/attempt-1/` with `prompt.md`, `output.log`, `fingerprint.json`, survives `proper-lockfile` concurrent check, and does not corrupt `harness/features/feature-list.json` `baseRevision`.
3. `package.json` version is `0.4.0` and `CHANGELOG.md` has `## [0.4.0]` entry describing worker isolation; enforcer still `tsc` clean with no `sendUserMessage` mid-stream regression.

## Evaluator Review (Evaluator fills in)

- [x] Scope is clear and bounded: yes — only `src/worker.ts` + `tmp/pi-harness/<run-id>/` + lock, no goal/remote.
- [x] Verification criteria are sufficient: yes — `tsc` + worker unit tests + isolated dir artifact + version/changelog.
- [x] Exclusions are reasonable: yes — F4/F5 deferred.

Agreed.

## Agreement Status

**Status:** Agreed
**Negotiation rounds:** 1/5
