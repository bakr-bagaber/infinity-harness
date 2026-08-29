# Constraints

## Technical

- **Language:** node ≥22 (ESM, `--experimental-strip-types`, `string-width` + `proper-lockfile` only)
- **Platform:** pi extension (adapter) + Node (core) + `pi --mode rpc` workers
- **Dependencies:** `proper-lockfile`, `string-width`; no new runtime dep without a reason
- **Isolation:** `execution.isolation` in `worktree` (default) or `none`; `maxWorkers` 1–16, clamped when isolation is `none`
- **Tiers:** `config.tiers` `A/B/C/D/X` with `run.json:baseModel` fallback; legacy `harness/model-router.json` migrated once
- **Limits:** `limits.unitWallClockMs`, `maxRecycles`, `maxReworkPerUnit`, `maxReplansPerPhase`, `tokenCap`, `costCap`

## Process

- Commits must be atomic (one concern per commit)
- All code reviewed before merging
- Tests must pass before shipping (`npm run check && npm test`)
- Gates are deterministic; advisory checks never deadlock the loop
- One implementation in `src/`; the extension is thin
- State is externalised (`harness/` on disk, `run.json`/`daemon.json` survive session handoff) — no closures holding run state

## Design

- Favor simplicity over generality
- Explicit over implicit
- Fail fast, fail loud where a caller cannot continue; `{ ok, error }` where it can
- Bounded stop: wall clock, iteration ceiling, no-progress, retry budgets, human brake — every stop names its reason
- Read-only, loopback-only surfaces (`remote`/`dashboard`)
