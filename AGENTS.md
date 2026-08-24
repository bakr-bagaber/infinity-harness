# Working in this repo

You are working inside **infinity-harness**, a pi extension that drives other agents through a gated
build pipeline. It is also driving *you* — the harness is dogfooded on itself.

## The loop

```
1. Read the brief          the harness injects it; infinity_brief re-prints it
2. Do the work it names    one task at a time
3. infinity_validate       the gate decides, not you
4. FAIL → fix exactly what it listed, validate again
5. PASS → the harness advances the phase and briefs you again
```

That is the whole workflow. When the brief says PAUSED or the pipeline is complete, stop and tell the
human.

## Rules

1. **Never mark your own work complete.** The gate is the only referee. Do not edit
   `harness/config.json` by hand — the extension blocks phase edits on a failing gate anyway, and
   working around it defeats the point of the tool.
2. **Never skip a phase.** Transitions are forward-only, one step at a time. If you think a phase is
   unnecessary, say so; do not route around it.
3. **Keep the plan honest.** When reality diverges from `harness/features/feature-list.json`, call
   `infinity_plan` with the current `baseRevision` and the *complete* task list. Omitted keys are
   deleted, so send everything you want to keep.
4. **Record surprises.** Non-obvious findings go in `harness/lessons-decisions.md`; architectural
   choices go in `harness/docs/DECISIONS.md` with the reasoning, not just the outcome.
5. **Commit after every validated task.** A long run should leave a readable history, not one
   enormous commit at the end.

## This codebase specifically

**One implementation.** `src/` holds every decision — phases, gates, plan, loop, rendering. The
extension in `extensions/infinity-harness/` owns pi's lifecycle and nothing else. If you find
yourself writing logic in the extension, it belongs in `src/`. An earlier version of this project
kept two copies that drifted apart; do not recreate that. The same rule caught a hand-written
second copy of `PHASE_ROLE` inside `core/config.ts`: adding a phase compiled fine and silently
reported the wrong role for it.

**Nothing that matters lives in the conversation.** The plan, the phase, the run's budgets and its
place on the escalation ladder are all files under `harness/`, because the run spans many pi
sessions and compaction eats transcripts. If you find yourself keeping run state in a closure in
the extension, that is the bug that ended every run at its first session handoff.

**Anything the agent must not forget goes in the system prompt.** `before_agent_start` is rebuilt
every turn and is never summarised; a message in the transcript is one compaction away from
"the assistant was working on a harness".

**A setting the person chose belongs to the person.** Saved workflows and display templates live in
`~/.pi/agent/infinity-harness/`, not under a project's `harness/`, because a workflow someone
designed is worth as much on their next project as on this one. Anything read on every render or in
a lifecycle hook is normalised on the way in (`normalizeDisplay`, `normalizeModes`): a hand-edited
config must produce a widget, never an exception that takes the session down.

**No new runtime dependencies without a reason.** The package ships with two (`proper-lockfile`,
`string-width`). Every addition is weight a user carries.

**Tests are plain `node:assert`.** No framework. Add a `tests/<module>.test.ts` that exits non-zero
on failure and it is picked up automatically. Test the contract, not the lines.

**Style.**
- TypeScript, `.ts` extensions on relative imports.
- Comment *why*, never *what*. If a comment restates the code, delete it.
- Errors are data where a caller can reasonably continue (`{ ok, error }`), thrown where they cannot.
- Anything that shells out goes through `src/core/exec.ts` so it is bounded by a timeout. A hung
  command in a multi-day run is a silent hang.
- Anything that writes state goes through `src/core/fsx.ts` so the write is atomic.

**Verify before you claim.** Run `npm run check` and `npm test` before saying something works. If a
test fails because you found a real bug, fix the bug — do not weaken the assertion.

**Prove it against a real pi.** `npm run e2e -- --only realpi` starts an actual `pi --mode rpc`
process against a scripted model and drives it the way a human would: typing slash commands,
answering wizard dialogs, reading the widget back. Everything else in the suite mocks pi, which
means it can prove our contracts and cannot prove pi's — and every bug that has reached a user so
far lived in exactly that gap. If you change anything that touches pi's lifecycle (message
delivery, sessions, compaction, shortcuts, dialogs), add a step there before you call it done.

## Reference

- `README.md` — what the product is and how it is used
- `harness/docs/ARCHITECTURE.md` — module structure and data flow
- `harness/docs/DECISIONS.md` — why things are the way they are
- `harness/skills/` — craft skills the brief points at; read the one it names before starting
