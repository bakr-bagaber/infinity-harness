---
name: cli-design
description: Command-line tool design — argument conventions, output contracts, exit codes, composability
tags: [cli, command, terminal, flags, arguments, stdout, stdin, shell, script, tool]
when: task builds or extends a command-line interface
phases: [plan, build]
provenance: { origin: built-in }
---

# CLI Design

## Rules

- **stdout is the product; stderr is the commentary.** Results (the thing
  a pipe consumes) go to stdout; progress, warnings, and errors go to
  stderr. Mixing them breaks every script that consumes you.
- **Exit codes are the API:** 0 success · 1 operation failed · 2 usage
  error. Scripts branch on these; a CLI that exits 0 on failure is lying
  to automation.
- **`--help` on everything**, including subcommands: one-line purpose,
  usage line, every flag with its default. Help exits 0; unknown flags
  exit 2 naming the flag and suggesting help.
- **Machine mode:** `--json` emits one parseable object/line to stdout
  with a stable shape — additive changes only; renames are breaking
  changes. (Agents and scripts are your biggest users.)
- **Non-interactive by default.** Prompts hang cron jobs and agents. Take
  input via flags/stdin; destructive actions get `--dry-run` (show, don't
  do) and require `--force` instead of asking "are you sure?".
- **Follow the grain:** `tool <noun> <verb>` or `tool <verb>` —
  consistently; flags kebab-case with `--long` forms; `-` means stdin/
  stdout where files are expected; respect `NO_COLOR` and non-TTY (no
  spinners into pipes).
- **Errors say what + why + what next:** `✗ config not found:
  harness/config.json — run: dev-harness init`. Never a bare stack trace
  for an expected failure.
- **Fast startup matters.** A CLI invoked in loops pays its startup cost
  ×N — lazy-load heavy imports per subcommand.

## Anti-patterns

- **Chatty stdout** — banner + tips drowning the result → result only;
  decorations to stderr or behind `--verbose`.
- **Boolean flags taking values** (`--force true`) → presence = true.
- **Positional soup** (`tool a b c d`) — 3+ positionals nobody remembers →
  named flags for all but the primary argument.
- **Config file required to run at all** → flags work standalone; config
  file provides defaults, flags override.

## Checklist

- [ ] Piping stdout to a file captures exactly the result, nothing else
- [ ] Exit codes verified: success=0, failure=1, bad usage=2
- [ ] `--json` output parses and has a documented shape
- [ ] Runs unattended: zero prompts anywhere
- [ ] Every destructive path has --dry-run and needs --force
