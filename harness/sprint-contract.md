# Sprint Contract — pi-harness F2 v0.3.0

## Scope (Generator proposes)

**I will build:**
F2 Enforcer Auto-Loop Hardening (v0.3.0). Harden extensions/harness-enforcer/index.ts from F1 notify-only to full auto-loop: session_start auto-injects dev-harness next brief (notify+widget, no mid-stream send), context checkpoint injection (99people hidden harness:checkpoint with baseRevision), periodic reminder every 3 calls, tool_call guard blocking harness/config.json phase-skip without PASS, session_before_compact checkpoint via appendEntry, and dev-harness run uses high not xhigh with no -e. Keep cli/lib reuse via symlink, tsc clean, 5-level widget intact.

**I will NOT build:**
Worker-isolated BUILD per task (F3), Goal loop GOAL_SPEC.json (F4), Remote web view (F5), new harness phases/gates beyond define-to-ship.

## Verification Criteria (Generator proposes)

1. Pi with pi-harness extension in a harness project: session_start shows notify and widget, context injects hidden checkpoint after compaction, reminder every 3 LLM calls, turn_end only notifies without stream race.
2. tool_call blocks harness/config.json hand-edit of currentPhase without validate PASS; session_before_compact stores appendEntry checkpoint.
3. npx tsc --noEmit passes; dev-harness run uses high not xhigh and no -e flag; package.json version is 0.3.0.

## Evaluator Review (Evaluator fills in)

- [x] Scope is clear and bounded: yes — only enforcer hardening, no worker/goal/remote.
- [x] Verification criteria are sufficient: yes — start/context/turn/tool/compact plus tsc and version.
- [x] Exclusions are reasonable: yes — F3-F5 deferred.

Agreed.

## Agreement Status

**Status:** Agreed
**Negotiation rounds:** 1/5
