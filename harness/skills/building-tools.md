---
name: building-tools
description: Project script standards — idempotent, self-documenting, non-interactive executables
tags: [meta, tool, script, cli, automation, executable, makefile]
when: a repeatable action deserves a script instead of the same shell dance twice
phases: []
kind: meta
provenance: { origin: built-in }
---

# Building Tools

Build one when you catch yourself doing the same multi-step shell dance
twice. The bar is not "it worked once on my machine" — an unattended agent
will run this at 3am with no one watching.

There is nothing to register. A script in the repo, named in `AGENTS.md` or
`package.json`, is discoverable by the next session; a script nobody can
find is a script nobody runs.

## Standards

- **Idempotent** — running it twice is safe and converges to the same state.
- **`--help` works** — prints usage and purpose, exits 0. This is the first
  thing anyone runs, human or model.
- **`--json` where output is consumed** — machine-readable when something
  downstream reads the result. Humans get the summary line.
- **Exit codes** — `0` success · `1` the operation failed · `2` you were
  called wrong. An agent branches on these; get them right.
- **Never interactive** — no prompts, no confirmations, no "are you sure".
  Flags only.
- **Fail loud and specific** — errors name the thing that is wrong and the
  likely fix, on stderr. "Error: 1" costs someone an hour.
- **Self-contained** — resolve paths from the project root, not the
  caller's cwd. Check prerequisites at startup and fail with the install
  command.

## Anti-patterns

- **The snowflake** — hardcoded paths, undeclared dependencies, works only
  where it was written. Fix: check prerequisites first, fail with
  instructions.
- **The chatterbox** — pages of output hiding the result. Fix: one summary
  line by default, `--verbose` for the rest.
- **The mutation surprise** — destructive with no dry run. Fix: anything
  destructive gets `--dry-run`, and says what it would do.
- **The second source of truth** — a script that keeps its own copy of state
  the project already stores. Fix: read the real file.

## Checklist

- [ ] Ran it twice; the second run was a no-op
- [ ] `--help` exits 0 and explains the purpose
- [ ] Exit codes are 0 / 1 / 2 and mean what they should
- [ ] No prompt, no confirmation, no TTY assumption
- [ ] Named somewhere a cold reader will find it
