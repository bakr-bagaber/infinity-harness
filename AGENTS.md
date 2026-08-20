# Node.js — Dev Harness

## Project
- **Stack:** node
- **Mode:** copilot / autopilot (`dev-harness status` shows current)
- **Pipeline:** driven by dev-harness — you do the work, the harness computes
  your next step and verifies the result with deterministic gates.

## THE LOOP — this is 95% of what you need

```
1. dev-harness next          ← your complete brief: role, goal, task, criteria
2. Do the work it describes  (read the phase doc + craft skill it lists)
3. Run the validate command the brief gives you
4. FAIL → fix the listed checks, validate again
5. PASS → dev-harness phase next  → back to step 1
```

Repeat until `next` says the pipeline is complete. If `next` says PAUSED,
stop and tell the human. That's the whole workflow.

Briefs include CAPABILITIES matched to your task (skills/MCP/tools from
`harness/skills/` + the index). If a brief says ACQUIRE FIRST, follow the
ladder: `dev-harness capability search` → adapt+add, or create — see
`harness/skills/capability-acquisition.md`. Never let acquisition block
the task (record the gap and proceed).

> MCP: if your tool loaded the dev-harness MCP server, `harness_next`,
> `harness_validate`, `harness_advance` are the same loop as native tools.

## Quick Start

```bash
dev-harness next          # What do I do now? (call first, and after every validate)
dev-harness status        # Full state: phase, feature, task, gates, lessons
dev-harness validate      # Check gate criteria (the referee)
dev-harness phase next    # Advance when the gate passes
dev-harness learn "text"  # Save a lesson    | dev-harness decision "x"  # Record a decision
```

## Rules (non-negotiable)

1. NEVER skip phases, edit `harness/config.json` by hand, or mark work
   complete yourself — `validate` is the only referee.
2. No agent evaluates its own work by feel — when validating, put on the
   Evaluator hat and judge as if someone else wrote it. (Multi-session
   setups: `config set roles.strict true` makes role gates blocking.)
3. Trust the brief. `next` computes the step from real state; don't invent
   your own plan for what the pipeline should do.
4. Read the craft skill the brief points at (`harness/skills/`) BEFORE
   working — it changes how an expert does this step.
5. Record surprises: `dev-harness learn "..."`. Commit after every
   validated task.
6. Structure from the start: `src/`, `tests/`, `docs/`, `scripts/` — no
   stray files in the project root.

## Phase Pipeline

INIT → DEFINE → PLAN → BUILD → VERIFY → [SIMPLIFY] → REVIEW → SHIP

See `harness/docs/phases/<phase>.md` for phase instructions —
`dev-harness next` tells you which one to read.

| Phase | Role | Craft skills (`harness/skills/`) |
|-------|------|----------------------------------|
| DEFINE | Planner | grilling, domain-modeling, research |
| PLAN | Planner | planning-tasks, codebase-design |
| BUILD | Generator | tdd, prototype |
| VERIFY | Evaluator | diagnosing-bugs, tdd |
| SIMPLIFY | Simplifier | codebase-design, code-review |
| REVIEW | Evaluator | code-review |
| SHIP | Generator | — |

## Agent Roles

Role guides live in `harness/docs/agents/` (planner.md, generator.md,
evaluator.md, simplifier.md). Default mode: one agent switches hats —
`dev-harness role <name>` records the switch and injects the persona.

## Session start / session end

**Start:** `dev-harness next` (it reads the previous session's handoff).
**End:** finish the current step, then `git commit -am "session: <what>"`.
The harness writes `harness/session-handoff.md` at every boundary; the next
session resumes from it automatically.

## Key Files

| File | Purpose |
|------|---------|
| `harness/features/feature-list.json` | Features + tasks + acceptance criteria (PLAN writes; BUILD works) |
| `harness/sprint-contract.md` | Scope + verification criteria agreed before building |
| `harness/skills/` | Craft skills — how to do each phase's work well |
| `harness/capability/` | Capability sources + index (`dev-harness capability ...`) |
| `harness/docs/DOMAIN.md` | Domain glossary (one concept, one name) |
| `harness/config.json` | Config + pipeline state (harness-managed) |
| `harness/progress.md` | Append-only history + lessons |
| `harness/session-handoff.md` | Clock-in/clock-out snapshot between sessions |
| `harness/evaluator-rubric.md` | Quality scorecard (filled during REVIEW) |
| `harness/scripts/init.sh` | Install → verify → start (environment bootstrap) |

## Dev Commands

Install: `npm install` · Build: `npm run build` · Test: `npm test` · Lint: `npx eslint .` · Type: `npx tsc --noEmit`
