---
name: building-tools
description: Project tool standards — idempotent, self-documenting, non-interactive executables
tags: [meta, tool, script, cli, automation, executable]
when: a repeatable action deserves a registered executable instead of ad-hoc shell
phases: []
provenance: { origin: built-in }
---

# Building Tools

A tool is a registered executable under `harness/tools/` that future
sessions (and other agents) can find and run. Build one when you catch
yourself doing the same multi-step shell dance twice.

## Process

1. `dev-harness capability create tool <name>` → stub at
   `harness/tools/<name>.sh` (any language works — .mjs, .py; the stub is
   bash).
2. Implement to the standards below.
3. Register:

   ```
   dev-harness capability add tool harness/tools/<name>.sh \
     --run "bash harness/tools/<name>.sh" \
     --tags db,fixtures --description "Reset local db to fixtures"
   ```

## Standards (the registration bar)

- **Idempotent** — running it twice is safe and converges to the same state.
- **`--help` works** — prints usage + purpose, exits 0. (`capability
  doctor` checks exactly this.)
- **`--json` where output is consumed** — machine-readable when another
  tool or agent reads the result.
- **Exit codes:** 0 success · 1 operation failed · 2 usage error.
- **Never interactive** — no prompts, no confirmations; flags only. An
  unattended agent runs this at 3am.
- **Fail loud and specific** — errors name the thing that's wrong and the
  likely fix, on stderr.
- **Self-contained** — resolve paths relative to the project root, not the
  caller's cwd.

## Anti-patterns

- **The snowflake** — works only on the author's machine (hardcoded paths,
  undeclared deps). Fix: check prerequisites at startup, fail with install
  instructions.
- **The chatterbox** — pages of output hiding the result. Fix: one summary
  line by default, `--verbose` for the rest.
- **The mutation surprise** — destructive with no dry-run. Fix: anything
  destructive gets `--dry-run` and defaults to showing what it would do.

## Checklist

- [ ] Idempotent (ran it twice to prove it)
- [ ] `--help` exit 0; exit codes correct
- [ ] Registered with ≥2 tags + description
- [ ] `dev-harness capability doctor --type tool` passes
