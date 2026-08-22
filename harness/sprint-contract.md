# Sprint Contract

## Scope (Generator proposes)

**I will build:**
F5 Remote Read-Only Web View → 1.0.0. Build src/remote.ts with buildRemoteState(projectDir) + createRemoteServer({port,host}) (node:http 127.0.0.1 ephemeral -> GET / HTML inline polling, GET /api/harness JSON RemoteState {baseRevision,features,goals,widgetLines,timestamp}, GET /api/health). Reads via readFileSync (no baseRevision increment); widget via src/widget.ts. Wire extensions/harness-enforcer hidden tool pi_harness_remote (alias harness_remote) {action:start|stop|status,port?,host?} delegating to src/remote.ts singleton, session_shutdown closes. Keep 5-level widget + harness_task_list + Goal Loop intact; reuse define→ship.

**I will NOT build:**
Remote mutation (no POST), auth/QR/tunnel helper, new harness phases/gates, pi --loop daemon beyond per-task isolation, external hosting.

## Verification Criteria (Generator proposes)

npx tsc --noEmit passes; src/remote.ts exists with buildRemoteState/createRemoteServer, tests/remote.test.ts passing (start on 127.0.0.1:0, GET /api/harness shape baseRevision/widgetLines/timestamp, GET / HTML contains pi-harness + baseRevision, concurrent fetches serialized, close frees port, HTML escaping).
Remote read-only demonstrated: fetch /api/harness reflects baseRevision + widgetLines without mutating file; fetch / returns HTML with Progress and widget lines; close() stops server; repeated start/stop does not corrupt baseRevision or feature-list.json.
package.json 1.0.0 and CHANGELOG.md ## [1.0.0] with remote; enforcer tsc clean no sendUserMessage regression and exposes pi_harness_remote alias harness_remote.

## Evaluator Review (Evaluator fills in)

- [x] Scope is clear and bounded: yes — src/remote.ts read-only (GET / HTML + GET /api/harness JSON + /api/health) plus enforcer pi_harness_remote alias harness_remote with {start|stop|status}
- [x] Verification criteria are sufficient: yes — tsc + tests/remote.test.ts (ephemeral + shape + HTML + concurrent + close + escaping) + read-only demo (baseRevision unchanged) + 1.0.0 version/changelog + enforcer alias
- [x] Exclusions are reasonable: yes — POST/auth/QR/tunnel/new phases deferred

Agreed.



## Agreement Status

**Status:** Agreed
**Negotiation rounds:** 2/5

